pragma solidity 0.8.23;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract YieldGekoSwapper is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    mapping(address => bool) public approvedDEXes;
    mapping(address => string) public dexNames;
    address[] public dexList;

    mapping(address => bool) public authorizedCallers;

    event DEXAdded(address indexed dex, string name);
    event DEXRemoved(address indexed dex);
    event CallerAuthorized(address indexed caller, bool authorized);
    event SwapExecuted(
        address indexed dex,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address recipient
    );

    error UnauthorizedCaller(address caller);
    error UnapprovedDEX(address dex);
    error SlippageExceeded(uint256 received, uint256 minRequired);
    error SwapFailed(address dex, bytes returnData);
    error ZeroAddress();
    error ZeroAmountIn();
    error EthTransferFailed();

    address public constant ETH = address(0);

    modifier onlyAuthorized() {
        if (!authorizedCallers[msg.sender]) revert UnauthorizedCaller(msg.sender);
        _;
    }

    constructor(address _owner) Ownable(_owner) {}

    function setAuthorizedCaller(address _caller, bool _authorized) external onlyOwner {
        if (_caller == address(0)) revert ZeroAddress();
        authorizedCallers[_caller] = _authorized;
        emit CallerAuthorized(_caller, _authorized);
    }

    function addDEX(address _dex, string calldata _name) external onlyOwner {
        if (_dex == address(0)) revert ZeroAddress();
        if (!approvedDEXes[_dex]) {
            approvedDEXes[_dex] = true;
            dexNames[_dex] = _name;
            dexList.push(_dex);
            emit DEXAdded(_dex, _name);
        }
    }

    function removeDEX(address _dex) external onlyOwner {
        approvedDEXes[_dex] = false;
        emit DEXRemoved(_dex);
    }

    function swap(
        address _dex,
        bytes calldata _calldata,
        address _tokenIn,
        address _tokenOut,
        uint256 _amountIn,
        uint256 _minAmountOut,
        address _recipient
    ) external payable nonReentrant returns (uint256 amountOut) {
        if (!approvedDEXes[_dex]) revert UnapprovedDEX(_dex);
        if (_amountIn == 0) revert ZeroAmountIn();

        uint256 balanceBefore =
            _tokenOut == ETH ? address(this).balance - msg.value : IERC20(_tokenOut).balanceOf(address(this));

        if (_tokenIn != ETH) {
            IERC20(_tokenIn).safeTransferFrom(msg.sender, address(this), _amountIn);
            IERC20(_tokenIn).forceApprove(_dex, _amountIn);
        }

        uint256 ethValue = _tokenIn == ETH ? _amountIn : 0;
        (bool success, bytes memory returnData) = _dex.call{value: ethValue}(_calldata);
        if (!success) revert SwapFailed(_dex, returnData);

        uint256 balanceAfter = _tokenOut == ETH ? address(this).balance : IERC20(_tokenOut).balanceOf(address(this));

        amountOut = balanceAfter - balanceBefore;

        if (amountOut < _minAmountOut) revert SlippageExceeded(amountOut, _minAmountOut);

        if (_tokenIn != ETH) {
            IERC20(_tokenIn).forceApprove(_dex, 0);
        }

        if (_tokenOut != ETH) {
            IERC20(_tokenOut).safeTransfer(_recipient, amountOut);
        } else {
            (bool sent,) = _recipient.call{value: amountOut}("");
            if (!sent) revert EthTransferFailed();
        }

        emit SwapExecuted(_dex, _tokenIn, _tokenOut, _amountIn, amountOut, _recipient);
    }

    function getDEXCount() external view returns (uint256) {
        return dexList.length;
    }

    function getActiveDEXes() external view returns (address[] memory active, string[] memory names) {
        uint256 total = dexList.length;
        uint256 count = 0;

        for (uint256 i = 0; i < total; ++i) {
            if (approvedDEXes[dexList[i]]) ++count;
        }

        active = new address[](count);
        names = new string[](count);
        uint256 idx = 0;

        for (uint256 i = 0; i < total; ++i) {
            if (approvedDEXes[dexList[i]]) {
                active[idx] = dexList[i];
                names[idx] = dexNames[dexList[i]];
                ++idx;
            }
        }
    }

    receive() external payable {}
}
