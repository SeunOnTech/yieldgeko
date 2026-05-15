import json
import sys
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import numpy as np


@dataclass
class ChaosConfig:
    simulations: int = 1000
    time_horizon_days: int = 30
    target_return: float = 5.0
    max_volatility: float = 1.25
    min_volatility: float = 0.05


class ChaosEngine:
    def __init__(self, config: Optional[ChaosConfig] = None):
        self.config = config or ChaosConfig()

    def calculate_true_volatility(self, history: List[Dict[str, Any]], default_vol: float) -> float:
        if len(history) < 5:
            return default_vol

        sorted_history = sorted(history, key=self._timestamp_key)
        apys = np.array([self._float_or_default(point.get("grossAPY"), 0.0) for point in sorted_history], dtype=float)
        apys = apys[apys > 0]

        if apys.size < 3:
            return default_vol

        returns = np.diff(apys) / np.maximum(apys[:-1], 1e-6)
        if returns.size < 2:
            return default_vol

        hist_vol = float(np.std(returns) * np.sqrt(365.0))
        return float(min(self.config.max_volatility, max(self.config.min_volatility, hist_vol)))

    def analyze_momentum(self, history: List[Dict[str, Any]]) -> float:
        if len(history) < 2:
            return 1.0

        sorted_history = sorted(history, key=self._timestamp_key)
        apys = np.array([self._float_or_default(point.get("grossAPY"), 0.0) for point in sorted_history], dtype=float)
        apys = apys[apys > 0]

        if apys.size < 2:
            return 1.0

        recent = apys[-5:]
        slope = float(np.polyfit(np.arange(len(recent), dtype=float), recent, 1)[0]) if recent.size >= 2 else 0.0

        mean = float(np.mean(apys))
        stability = 1.0 - float(np.std(apys) / max(mean, 1e-6))

        normalized_slope = slope / max(abs(mean), 1.0)
        momentum = 1.0
        if normalized_slope < -0.08:
            momentum *= 0.90
        elif normalized_slope > 0.04:
            momentum *= 1.06

        if stability > 0.90:
            momentum *= 1.02

        return float(min(1.10, max(0.85, momentum)))

    def derive_liquidity_score(self, liquidity_usd: float) -> float:
        # 100k liquidity is barely acceptable, 10m+ gets close to max score.
        if liquidity_usd <= 0:
            return 5.0
        score = 25.0 + 18.0 * np.log10(max(liquidity_usd, 1.0) / 100_000.0 + 1.0)
        return float(min(100.0, max(5.0, score)))

    def default_volatility(self, strategy_type: str) -> float:
        vol_map = {
            "LENDING": 0.12,
            "LP": 0.30,
            "DERIVATIVE": 0.45,
            "DELTA_NEUTRAL": 0.22,
        }
        return float(vol_map.get(strategy_type, 0.35))

    def _timestamp_key(self, point: Dict[str, Any]) -> float:
        raw = point.get("timestamp", 0)
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return 0.0
        return value if np.isfinite(value) else 0.0

    def _float_or_default(self, value: Any, default: float) -> float:
        try:
            parsed = float(value)
        except (TypeError, ValueError):
            return default
        return parsed if np.isfinite(parsed) else default

    def simulate_yield_path(
        self,
        current_apy: float,
        volatility: float,
        liquidity_score: float,
        momentum_mult: float,
        verified: bool,
        rng: np.random.Generator,
    ) -> np.ndarray:
        steps = self.config.time_horizon_days
        reversion_speed = 0.18
        liquidity_penalty = max(0.0, (70.0 - liquidity_score) / 70.0)
        verification_penalty = 0.12 if not verified else 0.0

        adjusted_vol = volatility * (1.0 + liquidity_penalty + verification_penalty)
        if momentum_mult < 1.0:
            adjusted_vol *= 1.10

        long_run_apy = max(0.0, current_apy * momentum_mult * (0.98 if not verified else 1.0))
        daily_sigma = max(0.20, current_apy * adjusted_vol * 0.18) / max(np.sqrt(steps), 1.0)
        shocks = rng.normal(0.0, daily_sigma, (self.config.simulations, steps))

        apy_paths = np.zeros((self.config.simulations, steps), dtype=float)
        apy_paths[:, 0] = max(current_apy, 0.01)

        for step in range(1, steps):
            prev = apy_paths[:, step - 1]
            drift = reversion_speed * (long_run_apy - prev)
            apy_paths[:, step] = np.maximum(0.0, prev + drift + shocks[:, step])

        return apy_paths

    def calculate_sortino(self, paths: np.ndarray) -> float:
        final_returns = paths[:, -1]
        expected_return = float(np.mean(final_returns))
        downside = final_returns[final_returns < self.config.target_return]

        if downside.size == 0:
            return 10.0

        downside_deviation = float(np.sqrt(np.mean((downside - self.config.target_return) ** 2)))
        return float((expected_return - self.config.target_return) / max(downside_deviation, 1e-6))

    def estimate_il_drag(
        self,
        strategy_type: str,
        volatility: float,
        current_apy: float,
        lp_context: Optional[Dict[str, Any]],
    ) -> float:
        if strategy_type != "LP" or not lp_context:
            return 0.0

        pair_type = str(lp_context.get("pairType", "volatile-volatile"))
        il_flag = bool(lp_context.get("ilRiskFlag", False))
        volume_to_tvl = self._float_or_default(lp_context.get("volumeToTvlRatio"), 0.0)
        fee_tier_bps = self._float_or_default(lp_context.get("feeTierBps"), 3000.0)

        pair_multiplier = {
            "stable-stable": 0.18,
            "stable-volatile": 0.65,
            "volatile-volatile": 1.0,
        }.get(pair_type, 1.0)

        il_risk_multiplier = 1.1 if il_flag else 0.95
        exitability_discount = 1.0
        if volume_to_tvl >= 5:
            exitability_discount *= 0.82
        elif volume_to_tvl >= 2:
            exitability_discount *= 0.9
        elif volume_to_tvl <= 0.5:
            exitability_discount *= 1.12

        fee_tier_discount = 0.95 if fee_tier_bps <= 500 else 1.0 if fee_tier_bps <= 3000 else 1.08

        drag = current_apy * volatility * 0.32 * pair_multiplier * il_risk_multiplier * exitability_discount * fee_tier_discount
        return max(0.0, float(drag))

    def calculate_confidence(
        self,
        paths: np.ndarray,
        sortino: float,
        volatility: float,
        liquidity_score: float,
        verified: bool,
        history_points: int,
        net_expected_apy: float,
    ) -> float:
        final_apys = paths[:, -1]
        min_apys = np.min(paths, axis=1)
        upside_prob = float(np.mean(final_apys >= self.config.target_return))
        floor_prob = float(np.mean(min_apys >= self.config.target_return * 0.5))
        sortino_score = float(np.clip((sortino + 0.5) / 2.5, 0.0, 1.0))
        stability_score = float(np.clip(1.0 - (volatility / self.config.max_volatility), 0.0, 1.0))
        history_quality = float(np.clip(history_points / 30.0, 0.0, 1.0))
        net_edge_score = float(np.clip(net_expected_apy / max(self.config.target_return, 1.0), 0.0, 2.0) / 2.0)

        confidence = 100.0 * (
            0.25 * upside_prob
            + 0.15 * floor_prob
            + 0.15 * sortino_score
            + 0.10 * stability_score
            + 0.10 * (liquidity_score / 100.0)
            + 0.10 * history_quality
            + 0.15 * net_edge_score
        )

        if not verified:
            confidence *= 0.88
        if history_points < 5:
            confidence *= 0.72
        elif history_points < 14:
            confidence *= 0.86

        return float(np.clip(confidence, 0.0, 100.0))

    def stress_test(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        seed = int(payload.get("seed", 0))
        rng = np.random.default_rng(seed)

        apy = float(payload.get("grossAPY", 0.0))
        history = payload.get("history", [])
        strategy_type = payload.get("strategyType", "LP")
        liquidity_usd = float(payload.get("liquidityUSD", 0.0))
        verified = bool(payload.get("verified", False))
        selection_score = self._float_or_default(payload.get("selectionScore"), 0.0)
        lp_context = payload.get("lpContext")
        history_points = len(history)

        base_vol = self.default_volatility(strategy_type)
        true_vol = self.calculate_true_volatility(history, base_vol)
        momentum = self.analyze_momentum(history)
        liquidity_score = self.derive_liquidity_score(liquidity_usd)

        paths = self.simulate_yield_path(apy, true_vol, liquidity_score, momentum, verified, rng)
        sortino = self.calculate_sortino(paths)
        expected_apy = float(np.mean(paths[:, -1]))
        il_drag = self.estimate_il_drag(strategy_type, true_vol, apy, lp_context if isinstance(lp_context, dict) else None)
        net_expected_apy = max(0.0, expected_apy - il_drag)
        confidence = self.calculate_confidence(paths, sortino, true_vol, liquidity_score, verified, history_points, net_expected_apy)
        median_final_apy = float(np.median(paths[:, -1])) - il_drag
        upside_prob = float(np.mean(paths[:, -1] >= self.config.target_return))
        selection_gate = selection_score >= 25 if strategy_type == "LP" else True
        status = "APPROVED" if confidence >= 60.0 and sortino >= 0.25 and upside_prob >= 0.60 and median_final_apy >= self.config.target_return and selection_gate else "REJECTED"

        return {
            "id": payload.get("id"),
            "expected_apy": round(expected_apy, 6),
            "net_expected_apy": round(net_expected_apy, 6),
            "estimated_il_drag": round(il_drag, 6),
            "true_volatility": round(true_vol, 6),
            "sortino_ratio": round(sortino, 6),
            "momentum_factor": round(momentum, 6),
            "chaos_confidence": round(confidence, 6),
            "status": status,
            "simulation_seed": seed,
        }


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw and len(sys.argv) > 1:
        raw = sys.argv[1]

    if not raw:
        raise ValueError("No simulation payload supplied")

    payload = json.loads(raw)
    engine = ChaosEngine()
    print(json.dumps(engine.stress_test(payload)))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        raise SystemExit(1)
