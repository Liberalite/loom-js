"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tslib_1 = require("tslib");
var ethereumjs_util_1 = tslib_1.__importDefault(require("ethereumjs-util"));
var web3_1 = tslib_1.__importDefault(require("web3"));
var ethers_1 = require("ethers");
var web3 = new web3_1.default();
function soliditySha3() {
    var values = [];
    for (var _i = 0; _i < arguments.length; _i++) {
        values[_i] = arguments[_i];
    }
    var _a;
    return (_a = web3.utils).soliditySha3.apply(_a, values);
}
exports.soliditySha3 = soliditySha3;
/**
 * Signs message using a Web3 account.
 * This signer should be used for interactive signing in the browser with MetaMask.
 */
var Web3Signer = /** @class */ (function () {
    /**
     * @param web3 Web3 instance to use for signing.
     * @param accountAddress Address of web3 account to sign with.
     */
    function Web3Signer(wallet) {
        this._wallet = wallet;
    }
    /**
     * Signs a message.
     * @param msg Message to sign.
     * @returns Promise that will be resolved with the signature bytes.
     */
    Web3Signer.prototype.signAsync = function (msg) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var flatSig, sig, v;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._wallet.signMessage(ethers_1.ethers.utils.arrayify(msg))];
                    case 1:
                        flatSig = _a.sent();
                        sig = ethers_1.ethers.utils.splitSignature(flatSig);
                        v = sig.v;
                        if (v === 0 || v === 1) {
                            v += 27;
                        }
                        flatSig = '0x01' + sig.r.slice(2) + sig.s.slice(2) + (v).toString(16);
                        return [2 /*return*/, ethereumjs_util_1.default.toBuffer(flatSig)];
                }
            });
        });
    };
    return Web3Signer;
}());
exports.Web3Signer = Web3Signer;
//# sourceMappingURL=solidity-helpers.js.map