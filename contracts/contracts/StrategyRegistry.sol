// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title StrategyRegistry
 * @dev Audited version with active-list management and risk metadata.
 */
contract StrategyRegistry is Ownable {
    struct StrategyInfo {
        bool isActive;
        address adapter;
        string name;
        uint8 chainId;
        uint256 minLiquidity;
        bool isAudited;
        bool isPaused;
    }

    mapping(address => StrategyInfo) public strategies;
    mapping(address => uint256) private _strategyIndex;
    address[] private _activeStrategies;

    event StrategyAdded(address indexed strategy, address adapter, string name, uint8 chainId);
    event StrategyRemoved(address indexed strategy);
    event StrategyPaused(address indexed strategy);
    event StrategyUnpaused(address indexed strategy);

    constructor() Ownable(msg.sender) {}

    function addStrategy(
        address _strategy,
        address _adapter,
        string calldata _name,
        uint8 _chainId,
        uint256 _minLiquidity,
        bool _isAudited
    ) external onlyOwner {
        require(_strategy != address(0) && _adapter != address(0), "Zero address");
        require(!strategies[_strategy].isActive, "Strategy exists");

        strategies[_strategy] = StrategyInfo({
            isActive: true,
            adapter: _adapter,
            name: _name,
            chainId: _chainId,
            minLiquidity: _minLiquidity,
            isAudited: _isAudited,
            isPaused: false
        });

        _strategyIndex[_strategy] = _activeStrategies.length;
        _activeStrategies.push(_strategy);

        emit StrategyAdded(_strategy, _adapter, _name, _chainId);
    }

    function removeStrategy(address _strategy) external onlyOwner {
        require(strategies[_strategy].isActive, "Strategy not found");
        strategies[_strategy].isActive = false;

        // Remove from active list (swap-with-last)
        uint256 index = _strategyIndex[_strategy];
        address last = _activeStrategies[_activeStrategies.length - 1];

        _activeStrategies[index] = last;
        _strategyIndex[last] = index;

        _activeStrategies.pop();
        delete _strategyIndex[_strategy];

        emit StrategyRemoved(_strategy);
    }

    function pauseStrategy(address _strategy, bool _pause) external onlyOwner {
        require(strategies[_strategy].isActive, "Strategy not found");
        strategies[_strategy].isPaused = _pause;
        if (_pause) {
            emit StrategyPaused(_strategy);
        } else {
            emit StrategyUnpaused(_strategy);
        }
    }

    function isStrategyApproved(address _strategy) external view returns (bool) {
        StrategyInfo memory info = strategies[_strategy];
        return info.isActive && !info.isPaused;
    }

    function getActiveStrategies() external view returns (address[] memory) {
        return _activeStrategies;
    }

    function getStrategyInfo(address _strategy) external view returns (StrategyInfo memory) {
        return strategies[_strategy];
    }
}
