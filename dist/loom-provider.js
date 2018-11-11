"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tslib_1 = require("tslib");
var debug_1 = tslib_1.__importDefault(require("debug"));
var bn_js_1 = tslib_1.__importDefault(require("bn.js"));
var ethereumjs_util_1 = require("ethereumjs-util");
var retry_1 = tslib_1.__importDefault(require("retry"));
var client_1 = require("./client");
var helpers_1 = require("./helpers");
var loom_pb_1 = require("./proto/loom_pb");
var evm_pb_1 = require("./proto/evm_pb");
var address_1 = require("./address");
var crypto_utils_1 = require("./crypto-utils");
var solidity_helpers_1 = require("./solidity-helpers");
var big_uint_1 = require("./big-uint");
var log = debug_1.default('loom-provider');
var error = debug_1.default('loom-provider:error');
var bytesToHexAddrLC = function (bytes) {
    return crypto_utils_1.bytesToHexAddr(bytes).toLowerCase();
};
var numberToHexLC = function (num) {
    return crypto_utils_1.numberToHex(num).toLowerCase();
};
/**
 * Web3 provider that interacts with EVM contracts deployed on Loom DAppChains.
 */
var LoomProvider = /** @class */ (function () {
    /**
     * Constructs the LoomProvider to bridges communication between Web3 and Loom DappChains
     *
     * @param client Client from LoomJS
     * @param privateKey Account private key
     */
    function LoomProvider(client, privateKey) {
        var _this = this;
        /**
         * The retry strategy that should be used to retry some web3 requests.
         * Default is a binary exponential retry strategy with 5 retries.
         * To understand how to tweak the retry strategy see
         * https://github.com/tim-kos/node-retry#retrytimeoutsoptions
         */
        this.retryStrategy = {
            retries: 3,
            minTimeout: 1000,
            maxTimeout: 30000,
            randomize: true
        };
        this._client = client;
        this._accountMiddlewares = new Map();
        this.notificationCallbacks = new Array();
        this.accounts = new Map();
        this._client.addListener(client_1.ClientEvent.Contract, function (msg) {
            return _this._onWebSocketMessage(msg);
        });
        this.addDefaultEvents();
        this.addAccounts([privateKey]);
    }
    /**
     * Creates new accounts by passing the private key array
     *
     * Accounts will be available on public properties accounts
     *
     * @param accountsPrivateKey Array of private keys to create new accounts
     */
    LoomProvider.prototype.addAccounts = function (accountsPrivateKey) {
        var _this = this;
        accountsPrivateKey.forEach(function (accountPrivateKey) {
            var publicKey = crypto_utils_1.publicKeyFromPrivateKey(accountPrivateKey);
            var accountAddress = address_1.LocalAddress.fromPublicKey(publicKey).toString();
            _this.accounts.set(accountAddress, accountPrivateKey);
            _this._accountMiddlewares.set(accountAddress, helpers_1.createDefaultTxMiddleware(_this._client, accountPrivateKey));
            log("New account added " + accountAddress);
        });
    };
    // PUBLIC FUNCTION TO SUPPORT WEB3
    LoomProvider.prototype.on = function (type, callback) {
        switch (type) {
            case 'data':
                this.notificationCallbacks.push(callback);
                break;
            case 'connect':
                this._client.addListener(client_1.ClientEvent.Connected, callback);
                break;
            case 'end':
                this._client.addListener(client_1.ClientEvent.Disconnected, callback);
                break;
            case 'error':
                this._client.addListener(client_1.ClientEvent.Error, callback);
                break;
        }
    };
    LoomProvider.prototype.addDefaultEvents = function () {
        var _this = this;
        this._client.addListener(client_1.ClientEvent.Disconnected, function () {
            // reset all requests and callbacks
            _this.reset();
        });
    };
    LoomProvider.prototype.removeListener = function (type, callback) {
        switch (type) {
            case 'data':
                this.notificationCallbacks = [];
                break;
            case 'connect':
                this._client.removeListener(client_1.ClientEvent.Connected, callback);
                break;
            case 'end':
                this._client.removeListener(client_1.ClientEvent.Disconnected, callback);
                break;
            case 'error':
                this._client.removeListener(client_1.ClientEvent.Error, callback);
                break;
        }
    };
    LoomProvider.prototype.removeAllListeners = function (type, callback) {
        var _this = this;
        if (type === 'data') {
            this.notificationCallbacks.forEach(function (cb, index) {
                if (cb === callback) {
                    _this.notificationCallbacks.splice(index, 1);
                }
            });
        }
    };
    LoomProvider.prototype.reset = function () {
        this.notificationCallbacks = [];
    };
    LoomProvider.prototype.disconnect = function () {
        this._client.disconnect();
    };
    // Adapter function for sendAsync from truffle provider
    LoomProvider.prototype.sendAsync = function (payload, callback) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var _this = this;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!callback) return [3 /*break*/, 2];
                        return [4 /*yield*/, this.send(payload, callback)];
                    case 1:
                        _a.sent();
                        return [3 /*break*/, 3];
                    case 2: return [2 /*return*/, new Promise(function (resolve, reject) {
                            _this.send(payload, function (err, result) {
                                if (err)
                                    reject(err);
                                else
                                    resolve(result);
                            });
                        })];
                    case 3: return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Should be used to make async request
     * This method is used internally by web3, so we adapt it to be used with loom contract
     * when we are wrapping the evm on a DAppChain
     * @param payload JSON payload generated by web3 which will be translated to loom transaction/call
     * @param callback Triggered on end with (err, result)
     */
    LoomProvider.prototype.send = function (payload, callback) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var isArray, functionToExecute, f, result, err_1;
            var _this = this;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        log('Request payload', JSON.stringify(payload, null, 2));
                        isArray = Array.isArray(payload);
                        if (isArray) {
                            payload = payload[0];
                        }
                        functionToExecute = function (method) {
                            switch (method) {
                                case 'eth_accounts':
                                    return _this._ethAccounts;
                                case 'eth_blockNumber':
                                    return _this._ethBlockNumber;
                                case 'eth_call':
                                    return _this._ethCall;
                                case 'eth_estimateGas':
                                    return _this._ethEstimateGas;
                                case 'eth_gasPrice':
                                    return _this._ethGasPrice;
                                case 'eth_getBlockByHash':
                                    return _this._ethGetBlockByHash;
                                case 'eth_getBlockByNumber':
                                    return _this._ethGetBlockByNumber;
                                case 'eth_getCode':
                                    return _this._ethGetCode;
                                case 'eth_getFilterChanges':
                                    return _this._ethGetFilterChanges;
                                case 'eth_getLogs':
                                    return _this._ethGetLogs;
                                case 'eth_getTransactionByHash':
                                    return _this._ethGetTransactionByHash;
                                case 'eth_getTransactionReceipt':
                                    return _this._ethGetTransactionReceipt;
                                case 'eth_newBlockFilter':
                                    return _this._ethNewBlockFilter;
                                case 'eth_newFilter':
                                    return _this._ethNewFilter;
                                case 'eth_newPendingTransactionFilter':
                                    return _this._ethNewPendingTransactionFilter;
                                case 'eth_sendTransaction':
                                    return _this._ethSendTransaction;
                                case 'eth_sign':
                                    return _this._ethSign;
                                case 'eth_subscribe':
                                    return _this._ethSubscribe;
                                case 'eth_uninstallFilter':
                                    return _this._ethUninstallFilter;
                                case 'eth_unsubscribe':
                                    return _this._ethUnsubscribe;
                                case 'net_version':
                                    return _this._netVersion;
                                default:
                                    throw Error("Method \"" + payload.method + "\" not supported on this provider");
                            }
                        };
                        _a.label = 1;
                    case 1:
                        _a.trys.push([1, 3, , 4]);
                        f = functionToExecute(payload.method).bind(this);
                        return [4 /*yield*/, f(payload)];
                    case 2:
                        result = _a.sent();
                        callback(null, this._okResponse(payload.id, result, isArray));
                        return [3 /*break*/, 4];
                    case 3:
                        err_1 = _a.sent();
                        error(err_1);
                        callback(err_1, null);
                        return [3 /*break*/, 4];
                    case 4: return [2 /*return*/];
                }
            });
        });
    };
    // PRIVATE FUNCTIONS EVM CALLS
    LoomProvider.prototype._ethAccounts = function () {
        if (this.accounts.size === 0) {
            throw Error('No account available');
        }
        var accounts = new Array();
        this.accounts.forEach(function (value, key) {
            accounts.push(key);
        });
        return accounts;
    };
    LoomProvider.prototype._ethBlockNumber = function () {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var blockNumber;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.getBlockHeightAsync()];
                    case 1:
                        blockNumber = _a.sent();
                        return [2 /*return*/, crypto_utils_1.numberToHex(blockNumber)];
                }
            });
        });
    };
    LoomProvider.prototype._ethCall = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._callStaticAsync(payload.params[0])];
                    case 1:
                        result = _a.sent();
                        return [2 /*return*/, result ? bytesToHexAddrLC(result) : '0x0'];
                }
            });
        });
    };
    LoomProvider.prototype._ethEstimateGas = function () {
        // Loom DAppChain doesn't estimate gas, because gas isn't necessary
        return null; // Returns null to afford with Web3 calls
    };
    LoomProvider.prototype._ethGasPrice = function () {
        // Loom DAppChain doesn't use gas price, because gas isn't necessary
        return null; // Returns null to afford with Web3 calls
    };
    LoomProvider.prototype._ethGetBlockByHash = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var blockHash, isFull, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        blockHash = payload.params[0];
                        isFull = payload.params[1] || true;
                        return [4 /*yield*/, this._client.getEvmBlockByHashAsync(blockHash, isFull)];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/, this._createBlockInfo(result, isFull)];
                }
            });
        });
    };
    LoomProvider.prototype._ethGetBlockByNumber = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var blockNumberToSearch, isFull, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        blockNumberToSearch = payload.params[0];
                        isFull = payload.params[1] || true;
                        return [4 /*yield*/, this._client.getEvmBlockByNumberAsync(blockNumberToSearch, isFull)];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/, this._createBlockInfo(result, isFull)];
                }
            });
        });
    };
    LoomProvider.prototype._ethGetCode = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var address, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        address = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.params[0]));
                        return [4 /*yield*/, this._client.getEvmCodeAsync(address)];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            throw Error('No code returned on eth_getCode');
                        }
                        return [2 /*return*/, bytesToHexAddrLC(result)];
                }
            });
        });
    };
    LoomProvider.prototype._ethGetFilterChanges = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            var _this = this;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.getEvmFilterChangesAsync(payload.params[0])];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            return [2 /*return*/, []];
                        }
                        if (result instanceof evm_pb_1.EthBlockHashList) {
                            return [2 /*return*/, result
                                    .getEthBlockHashList_asU8()
                                    .map(function (hash) { return bytesToHexAddrLC(hash); })];
                        }
                        else if (result instanceof evm_pb_1.EthTxHashList) {
                            return [2 /*return*/, result
                                    .getEthTxHashList_asU8()
                                    .map(function (hash) { return bytesToHexAddrLC(hash); })];
                        }
                        else if (result instanceof evm_pb_1.EthFilterLogList) {
                            return [2 /*return*/, result
                                    .getEthBlockLogsList()
                                    .map(function (log) { return _this._createLogResult(log); })];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    LoomProvider.prototype._ethGetLogs = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            return tslib_1.__generator(this, function (_a) {
                return [2 /*return*/, this._getLogs(payload.params[0])];
            });
        });
    };
    LoomProvider.prototype._ethGetTransactionByHash = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            return tslib_1.__generator(this, function (_a) {
                return [2 /*return*/, this._getTransaction(payload.params[0])];
            });
        });
    };
    LoomProvider.prototype._ethGetTransactionReceipt = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var txHash, data, op, receipt;
            var _this = this;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        txHash = payload.params[0];
                        data = Buffer.from(txHash.slice(2), 'hex');
                        op = retry_1.default.operation(this.retryStrategy);
                        return [4 /*yield*/, new Promise(function (resolve, reject) {
                                op.attempt(function (currentAttempt) {
                                    _this._client
                                        .getEvmTxReceiptAsync(crypto_utils_1.bufferToProtobufBytes(data))
                                        .then(function (receipt) {
                                        if (receipt) {
                                            resolve(receipt);
                                        }
                                        else {
                                            var err = new Error('Receipt cannot be empty');
                                            error(err.message);
                                            if (!op.retry(err)) {
                                                reject(err);
                                            }
                                        }
                                    })
                                        .catch(function (err) {
                                        if (!op.retry(err)) {
                                            reject(err);
                                        }
                                        else {
                                            error(err.message);
                                        }
                                    });
                                });
                            })];
                    case 1:
                        receipt = _a.sent();
                        return [2 /*return*/, this._createReceiptResult(receipt)];
                }
            });
        });
    };
    LoomProvider.prototype._ethNewBlockFilter = function () {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.newBlockEvmFilterAsync()];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            throw Error('New block filter unexpected result');
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    LoomProvider.prototype._ethNewFilter = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.newEvmFilterAsync(payload.params[0])];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            throw Error('Cannot create new filter on eth_newFilter');
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    LoomProvider.prototype._ethNewPendingTransactionFilter = function () {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.newPendingTransactionEvmFilterAsync()];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            throw Error('New pending transaction filter unexpected result');
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    LoomProvider.prototype._ethSendTransaction = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        if (!payload.params[0].to) return [3 /*break*/, 2];
                        return [4 /*yield*/, this._callAsync(payload.params[0])];
                    case 1:
                        result = _a.sent();
                        return [3 /*break*/, 4];
                    case 2: return [4 /*yield*/, this._deployAsync(payload.params[0])];
                    case 3:
                        result = _a.sent();
                        _a.label = 4;
                    case 4: return [2 /*return*/, bytesToHexAddrLC(result)];
                }
            });
        });
    };
    LoomProvider.prototype._ethSign = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var address, privateKey, msg, hash, privateHash, sig;
            return tslib_1.__generator(this, function (_a) {
                address = payload.params[0];
                privateKey = this.accounts.get(address);
                if (!privateKey) {
                    throw Error('Account is not valid, private key not found');
                }
                msg = payload.params[1];
                hash = solidity_helpers_1.soliditySha3('\x19Ethereum Signed Message:\n32', msg).slice(2);
                privateHash = solidity_helpers_1.soliditySha3(privateKey).slice(2);
                sig = ethereumjs_util_1.ecsign(Buffer.from(hash, 'hex'), Buffer.from(privateHash, 'hex'));
                return [2 /*return*/, bytesToHexAddrLC(Buffer.concat([sig.r, sig.s, ethereumjs_util_1.toBuffer(sig.v)]))];
            });
        });
    };
    LoomProvider.prototype._ethSubscribe = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var method, filterObject, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        method = payload.params[0];
                        filterObject = payload.params[1] || {};
                        return [4 /*yield*/, this._client.evmSubscribeAsync(method, filterObject)];
                    case 1:
                        result = _a.sent();
                        if (!result) {
                            throw Error('Subscribe filter failed');
                        }
                        return [2 /*return*/, result];
                }
            });
        });
    };
    LoomProvider.prototype._ethUninstallFilter = function (payload) {
        return this._client.uninstallEvmFilterAsync(payload.params[0]);
    };
    LoomProvider.prototype._ethUnsubscribe = function (payload) {
        return this._client.evmUnsubscribeAsync(payload.params[0]);
    };
    LoomProvider.prototype._netVersion = function () {
        return this._client.chainId;
    };
    // PRIVATE FUNCTIONS IMPLEMENTATIONS
    LoomProvider.prototype._deployAsync = function (payload) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var caller, address, hasHexPrefix, data, deployTx, msgTx, tx, ret, response, responseData;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        caller = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.from));
                        address = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString('0x0000000000000000000000000000000000000000'));
                        hasHexPrefix = payload.data.substring(0, 2) === '0x';
                        data = Buffer.from(payload.data.slice(hasHexPrefix ? 2 : 0), 'hex');
                        deployTx = new loom_pb_1.DeployTx();
                        deployTx.setVmType(loom_pb_1.VMType.EVM);
                        deployTx.setCode(crypto_utils_1.bufferToProtobufBytes(data));
                        msgTx = new loom_pb_1.MessageTx();
                        msgTx.setFrom(caller.MarshalPB());
                        msgTx.setTo(address.MarshalPB());
                        msgTx.setData(deployTx.serializeBinary());
                        tx = new loom_pb_1.Transaction();
                        tx.setId(1);
                        tx.setData(msgTx.serializeBinary());
                        return [4 /*yield*/, this._commitTransaction(payload.from, tx)];
                    case 1:
                        ret = _a.sent();
                        response = loom_pb_1.DeployResponse.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(ret));
                        responseData = loom_pb_1.DeployResponseData.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(response.getOutput_asU8()));
                        return [2 /*return*/, responseData.getTxHash_asU8()];
                }
            });
        });
    };
    LoomProvider.prototype._callAsync = function (payload) {
        var caller = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.from));
        var address = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.to));
        var data = Buffer.from(payload.data.slice(2), 'hex');
        var value = new bn_js_1.default((payload.value || '0x0').slice(2), 16);
        var callTx = new loom_pb_1.CallTx();
        callTx.setVmType(loom_pb_1.VMType.EVM);
        callTx.setInput(crypto_utils_1.bufferToProtobufBytes(data));
        callTx.setValue(big_uint_1.marshalBigUIntPB(value));
        var msgTx = new loom_pb_1.MessageTx();
        msgTx.setFrom(caller.MarshalPB());
        msgTx.setTo(address.MarshalPB());
        msgTx.setData(callTx.serializeBinary());
        var tx = new loom_pb_1.Transaction();
        tx.setId(2);
        tx.setData(msgTx.serializeBinary());
        return this._commitTransaction(payload.from, tx);
    };
    LoomProvider.prototype._callStaticAsync = function (payload) {
        var caller = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.from));
        var address = new address_1.Address(this._client.chainId, address_1.LocalAddress.fromHexString(payload.to));
        var data = Buffer.from(payload.data.slice(2), 'hex');
        return this._client.queryAsync(address, data, loom_pb_1.VMType.EVM, caller);
    };
    LoomProvider.prototype._createBlockInfo = function (blockInfo, isFull) {
        var _this = this;
        var blockNumber = numberToHexLC(blockInfo.getNumber());
        var transactionHash = bytesToHexAddrLC(blockInfo.getHash_asU8());
        var parentHash = bytesToHexAddrLC(blockInfo.getParentHash_asU8());
        var logsBloom = bytesToHexAddrLC(blockInfo.getLogsBloom_asU8());
        var timestamp = blockInfo.getTimestamp();
        var transactions = blockInfo.getTransactionsList_asU8().map(function (transaction) {
            if (isFull) {
                return _this._createReceiptResult(evm_pb_1.EvmTxReceipt.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(transaction)));
            }
            else {
                return bytesToHexAddrLC(transaction);
            }
        });
        return {
            blockNumber: blockNumber,
            transactionHash: transactionHash,
            parentHash: parentHash,
            logsBloom: logsBloom,
            timestamp: timestamp,
            transactions: transactions
        };
    };
    LoomProvider.prototype._createReceiptResult = function (receipt) {
        var transactionHash = bytesToHexAddrLC(receipt.getTxHash_asU8());
        var transactionIndex = numberToHexLC(receipt.getTransactionIndex());
        var blockHash = bytesToHexAddrLC(receipt.getBlockHash_asU8());
        var blockNumber = numberToHexLC(receipt.getBlockNumber());
        var contractAddress = bytesToHexAddrLC(receipt.getContractAddress_asU8());
        var logs = receipt.getLogsList().map(function (logEvent, index) {
            var logIndex = numberToHexLC(index);
            var data = bytesToHexAddrLC(logEvent.getEncodedBody_asU8());
            if (data === '0x') {
                data = '0x0';
            }
            return {
                logIndex: logIndex,
                address: contractAddress,
                blockHash: blockHash,
                blockNumber: blockNumber,
                transactionHash: bytesToHexAddrLC(logEvent.getTxHash_asU8()),
                transactionIndex: transactionIndex,
                type: 'mined',
                data: data,
                topics: logEvent.getTopicsList().map(function (topic) { return topic.toLowerCase(); })
            };
        });
        return {
            transactionHash: transactionHash,
            transactionIndex: transactionIndex,
            blockHash: blockHash,
            blockNumber: blockNumber,
            contractAddress: contractAddress,
            gasUsed: numberToHexLC(receipt.getGasUsed()),
            cumulativeGasUsed: numberToHexLC(receipt.getCumulativeGasUsed()),
            logs: logs,
            status: numberToHexLC(receipt.getStatus())
        };
    };
    LoomProvider.prototype._getTransaction = function (txHash) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var data, transaction, hash, nonce, transactionIndex, blockHash, blockNumber, from, to, value, gasPrice, gas, input;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        data = Buffer.from(txHash.slice(2), 'hex');
                        return [4 /*yield*/, this._client.getEvmTxByHashAsync(crypto_utils_1.bufferToProtobufBytes(data))];
                    case 1:
                        transaction = _a.sent();
                        if (!transaction) {
                            throw Error('Transaction cannot be empty');
                        }
                        hash = bytesToHexAddrLC(transaction.getHash_asU8());
                        nonce = numberToHexLC(transaction.getNonce());
                        transactionIndex = numberToHexLC(transaction.getTransactionIndex());
                        blockHash = bytesToHexAddrLC(transaction.getBlockHash_asU8());
                        blockNumber = numberToHexLC(transaction.getBlockNumber());
                        from = bytesToHexAddrLC(transaction.getFrom_asU8());
                        to = bytesToHexAddrLC(transaction.getTo_asU8());
                        value = numberToHexLC(transaction.getValue());
                        gasPrice = numberToHexLC(transaction.getGasPrice());
                        gas = numberToHexLC(transaction.getGas());
                        input = '0x0';
                        return [2 /*return*/, {
                                hash: hash,
                                nonce: nonce,
                                blockHash: blockHash,
                                blockNumber: blockNumber,
                                transactionIndex: transactionIndex,
                                from: from,
                                to: to,
                                value: value,
                                gasPrice: gasPrice,
                                gas: gas,
                                input: input
                            }];
                }
            });
        });
    };
    LoomProvider.prototype._createLogResult = function (log) {
        return {
            removed: log.getRemoved(),
            logIndex: numberToHexLC(log.getLogIndex()),
            transactionIndex: crypto_utils_1.numberToHex(log.getTransactionIndex()),
            transactionHash: bytesToHexAddrLC(log.getTransactionHash_asU8()),
            blockHash: bytesToHexAddrLC(log.getBlockHash_asU8()),
            blockNumber: crypto_utils_1.numberToHex(log.getBlockNumber()),
            address: bytesToHexAddrLC(log.getAddress_asU8()),
            data: bytesToHexAddrLC(log.getData_asU8()),
            topics: log.getTopicsList().map(function (topic) { return String.fromCharCode.apply(null, topic); })
        };
    };
    LoomProvider.prototype._getLogs = function (filterObject) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var logsListAsyncResult, logList;
            var _this = this;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._client.getEvmLogsAsync(filterObject)];
                    case 1:
                        logsListAsyncResult = _a.sent();
                        if (!logsListAsyncResult) {
                            return [2 /*return*/, []];
                        }
                        logList = evm_pb_1.EthFilterLogList.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(logsListAsyncResult));
                        return [2 /*return*/, logList.getEthBlockLogsList().map(function (log) {
                                return _this._createLogResult(log);
                            })];
                }
            });
        });
    };
    LoomProvider.prototype._onWebSocketMessage = function (msgEvent) {
        if (msgEvent.data && msgEvent.id !== '0') {
            log("Socket message arrived " + JSON.stringify(msgEvent));
            this.notificationCallbacks.forEach(function (callback) {
                var JSONRPCResult = {
                    jsonrpc: '2.0',
                    method: 'eth_subscription',
                    params: {
                        subscription: msgEvent.id,
                        result: {
                            transactionHash: bytesToHexAddrLC(msgEvent.transactionHashBytes),
                            logIndex: '0x0',
                            transactionIndex: '0x0',
                            blockHash: '0x0',
                            blockNumber: '0x0',
                            address: msgEvent.contractAddress.local.toString(),
                            type: 'mined',
                            data: bytesToHexAddrLC(msgEvent.data),
                            topics: msgEvent.topics
                        }
                    }
                };
                callback(JSONRPCResult);
            });
        }
    };
    LoomProvider.prototype._commitTransaction = function (fromPublicAddr, txTransaction) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var middleware;
            return tslib_1.__generator(this, function (_a) {
                middleware = this._accountMiddlewares.get(fromPublicAddr);
                return [2 /*return*/, this._client.commitTxAsync(txTransaction, { middleware: middleware })];
            });
        });
    };
    // Basic response to web3js
    LoomProvider.prototype._okResponse = function (id, result, isArray) {
        if (result === void 0) { result = 0; }
        if (isArray === void 0) { isArray = false; }
        var response = { id: id, jsonrpc: '2.0', result: result };
        var ret = isArray ? [response] : response;
        log('Response payload', JSON.stringify(ret, null, 2));
        return ret;
    };
    return LoomProvider;
}());
exports.LoomProvider = LoomProvider;
//# sourceMappingURL=loom-provider.js.map