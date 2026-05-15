import type { AlphaOpportunity, OpportunityEvaluation } from '../types';

export interface ProtocolStrategyModel {
  readonly key: AlphaOpportunity['protocolKey'];
  supports(opportunity: AlphaOpportunity): boolean;
  evaluate(opportunity: AlphaOpportunity): OpportunityEvaluation;
}
