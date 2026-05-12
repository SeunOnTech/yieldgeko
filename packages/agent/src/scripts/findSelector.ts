const { ethers } = require('ethers');

const errors = [
  'UnauthorizedAgent(address)',
  'DelegationExpired(uint256,uint256)',
  'ManagedCapitalExceeded(uint256,uint256)',
  'DrawdownExceeded(uint256,uint256)',
  'ExcessiveFee(uint256,uint256)',
  'ZeroTreasury()',
  'ZeroFeeToken()',
  'CallerNotDelegationManager(address)'
];

errors.forEach(e => {
  const selector = ethers.id(e).slice(0, 10);
  console.log(`${selector}: ${e}`);
});
