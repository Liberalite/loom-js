"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tslib_1 = require("tslib");
var debug_1 = tslib_1.__importDefault(require("debug"));
var events_1 = tslib_1.__importDefault(require("events"));
var retry_1 = tslib_1.__importDefault(require("retry"));
var loom_pb_1 = require("./proto/loom_pb");
var evm_pb_1 = require("./proto/evm_pb");
var crypto_utils_1 = require("./crypto-utils");
var address_1 = require("./address");
var ws_rpc_client_1 = require("./internal/ws-rpc-client");
var json_rpc_client_1 = require("./internal/json-rpc-client");
var log = debug_1.default('client');
var ClientEvent;
(function (ClientEvent) {
    /**
     * Emitted when an event is received from a smart contract.
     * Listener will receive IChainEventArgs.
     */
    ClientEvent["Contract"] = "contractEvent";
    /**
     * Emitted when an error occurs that can't be relayed by other means.
     * Listener will receive IClientErrorEventArgs.
     */
    ClientEvent["Error"] = "error";
    /**
     * Emitted when a connection is established to the DAppChain.
     * Listener will receive INetEventArgs.
     */
    ClientEvent["Connected"] = "connected";
    /**
     * Emitted when a connection with the DAppChain is closed.
     * Listener will receive INetEventArgs.
     */
    ClientEvent["Disconnected"] = "disconnected";
})(ClientEvent = exports.ClientEvent || (exports.ClientEvent = {}));
var INVALID_TX_NONCE_ERROR = 'Invalid tx nonce';
function isInvalidTxNonceError(err) {
    return err instanceof Error && err.message === INVALID_TX_NONCE_ERROR;
}
exports.isInvalidTxNonceError = isInvalidTxNonceError;
/**
 * Writes to & reads from a Loom DAppChain.
 *
 * The client can listen to events emitted by smart contracts running on a DAppChain,
 * there is currently only one type of event. The event subscription API matches the NodeJS
 * EventEmitter API. For example...
 *
 * function subscribeToEvents(client: Client) {
 *   client.on(ClientEvent.Contract, (event: IChainEventArgs) => {
 *     // handle event
 *   }
 * }
 */
var Client = /** @class */ (function (_super) {
    tslib_1.__extends(Client, _super);
    function Client(chainId, writeClient, readClient) {
        var _this = _super.call(this) || this;
        /** Middleware to apply to transactions before they are transmitted to the DAppChain. */
        _this.txMiddleware = [];
        /**
         * The retry strategy that should be used to resend a tx when it's rejected because of a bad nonce.
         * Default is a binary exponential retry strategy with 5 retries.
         * To understand how to tweak the retry strategy see
         * https://github.com/tim-kos/node-retry#retrytimeoutsoptions
         */
        _this.nonceRetryStrategy = {
            retries: 5,
            minTimeout: 500,
            maxTimeout: 5000,
            randomize: true
        };
        _this.chainId = chainId;
        // TODO: basic validation of the URIs to ensure they have all required components.
        _this._writeClient =
            typeof writeClient === 'string' ? new ws_rpc_client_1.WSRPCClient(writeClient) : writeClient;
        _this._writeClient.on(json_rpc_client_1.RPCClientEvent.Error, function (url, err) {
            return _this._emitNetEvent(url, ClientEvent.Error, err);
        });
        _this._writeClient.on(json_rpc_client_1.RPCClientEvent.Connected, function (url) {
            return _this._emitNetEvent(url, ClientEvent.Connected);
        });
        _this._writeClient.on(json_rpc_client_1.RPCClientEvent.Disconnected, function (url) {
            return _this._emitNetEvent(url, ClientEvent.Disconnected);
        });
        if (!readClient || writeClient === readClient) {
            _this._readClient = _this._writeClient;
        }
        else {
            _this._readClient = typeof readClient === 'string' ? new ws_rpc_client_1.WSRPCClient(readClient) : readClient;
            _this._readClient.on(json_rpc_client_1.RPCClientEvent.Error, function (url, err) {
                return _this._emitNetEvent(url, ClientEvent.Error, err);
            });
            _this._readClient.on(json_rpc_client_1.RPCClientEvent.Connected, function (url) {
                return _this._emitNetEvent(url, ClientEvent.Connected);
            });
            _this._readClient.on(json_rpc_client_1.RPCClientEvent.Disconnected, function (url) {
                return _this._emitNetEvent(url, ClientEvent.Disconnected);
            });
        }
        var emitContractEvent = function (url, event) {
            return _this._emitContractEvent(url, event);
        };
        _this.on('newListener', function (event) {
            if (event === ClientEvent.Contract && _this.listenerCount(ClientEvent.Contract) === 0) {
                _this._readClient.on(json_rpc_client_1.RPCClientEvent.Message, emitContractEvent);
            }
        });
        _this.on('removeListener', function (event) {
            if (event === ClientEvent.Contract && _this.listenerCount(ClientEvent.Contract) === 0) {
                _this._readClient.removeListener(json_rpc_client_1.RPCClientEvent.Message, emitContractEvent);
            }
        });
        return _this;
    }
    Object.defineProperty(Client.prototype, "readUrl", {
        get: function () {
            return this._readClient.url;
        },
        enumerable: true,
        configurable: true
    });
    Object.defineProperty(Client.prototype, "writeUrl", {
        get: function () {
            return this._writeClient.url;
        },
        enumerable: true,
        configurable: true
    });
    /**
     * Cleans up all underlying network resources.
     * Once disconnected the client can no longer be used to interact with the DAppChain.
     */
    Client.prototype.disconnect = function () {
        this._writeClient.disconnect();
        if (this._readClient && this._readClient != this._writeClient) {
            this._readClient.disconnect();
        }
    };
    /**
     * Commits a transaction to the DAppChain.
     *
     * Consider using Contract.callAsync() instead.
     *
     * @param tx Transaction to commit.
     * @param opts Options object.
     * @param opts.middleware Middleware to apply before sending the tx to the DAppChain, setting this
     *                        option will override the default set of middleware specified in
     *                        the `Client.txMiddleware` property.
     * @returns Result (if any) returned by the tx handler in the contract that processed the tx.
     */
    Client.prototype.commitTxAsync = function (tx, opts) {
        var _this = this;
        if (opts === void 0) { opts = {}; }
        var _a = opts.middleware, middleware = _a === void 0 ? this.txMiddleware : _a;
        var op = retry_1.default.operation(this.nonceRetryStrategy);
        return new Promise(function (resolve, reject) {
            op.attempt(function (currentAttempt) {
                _this._commitTxAsync(tx, middleware)
                    .then(resolve)
                    .catch(function (err) {
                    if (err instanceof Error && err.message === INVALID_TX_NONCE_ERROR) {
                        if (!op.retry(err)) {
                            reject(err);
                        }
                    }
                    else {
                        op.stop();
                        reject(err);
                    }
                });
            });
        });
    };
    Client.prototype._commitTxAsync = function (tx, middleware) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var txBytes, i, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        txBytes = tx.serializeBinary();
                        i = 0;
                        _a.label = 1;
                    case 1:
                        if (!(i < middleware.length)) return [3 /*break*/, 4];
                        return [4 /*yield*/, middleware[i].Handle(txBytes)];
                    case 2:
                        txBytes = _a.sent();
                        _a.label = 3;
                    case 3:
                        i++;
                        return [3 /*break*/, 1];
                    case 4: return [4 /*yield*/, this._writeClient.sendAsync('broadcast_tx_commit', [crypto_utils_1.Uint8ArrayToB64(txBytes)])];
                    case 5:
                        result = _a.sent();
                        if (result) {
                            if ((result.check_tx.code || 0) != 0) {
                                if (!result.check_tx.log) {
                                    throw new Error("Failed to commit Tx: " + result.check_tx.code);
                                }
                                if (result.check_tx.code === 1 &&
                                    result.check_tx.log === 'sequence number does not match') {
                                    throw new Error(INVALID_TX_NONCE_ERROR);
                                }
                                throw new Error("Failed to commit Tx: " + result.check_tx.log);
                            }
                            if ((result.deliver_tx.code || 0) != 0) {
                                if (!result.deliver_tx.log) {
                                    throw new Error("Failed to commit Tx: " + result.deliver_tx.code);
                                }
                                throw new Error("Failed to commit Tx: " + result.deliver_tx.log);
                            }
                        }
                        if (result.deliver_tx.data) {
                            return [2 /*return*/, crypto_utils_1.B64ToUint8Array(result.deliver_tx.data)];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Queries the current state of a contract.
     *
     * Consider using Contract.staticCallAsync() instead.
     */
    Client.prototype.queryAsync = function (contract, query, vmType, caller) {
        if (vmType === void 0) { vmType = loom_pb_1.VMType.PLUGIN; }
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('query', {
                            contract: contract.local.toString(),
                            query: query ? crypto_utils_1.Uint8ArrayToB64(query) : undefined,
                            vmType: vmType,
                            caller: caller ? caller.toString() : undefined
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, crypto_utils_1.B64ToUint8Array(result)];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Queries the receipt corresponding to a transaction hash
     *
     * @param txHash Transaction hash returned by call transaction.
     * @return EvmTxReceipt The corresponding transaction receipt.
     */
    Client.prototype.getEvmTxReceiptAsync = function (txHash) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('evmtxreceipt', {
                            txHash: crypto_utils_1.Uint8ArrayToB64(txHash)
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, evm_pb_1.EvmTxReceipt.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(crypto_utils_1.B64ToUint8Array(result)))];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Returns the information about a transaction requested by transaction hash
     *
     * @param txHash Transaction hash returned by call transaction.
     * @return EvmTxObject The corresponding transaction object data.
     */
    Client.prototype.getEvmTxByHashAsync = function (txHash) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('getevmtransactionbyhash', {
                            txHash: crypto_utils_1.Uint8ArrayToB64(txHash)
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, evm_pb_1.EvmTxObject.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(crypto_utils_1.B64ToUint8Array(result)))];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Queries the code corresponding to a contract
     *
     * @param contractAddress Contract address returned by deploy.
     * @return Uint8Array The corresponding contract code
     */
    Client.prototype.getEvmCodeAsync = function (contractAddress) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('getevmcode', {
                            contract: contractAddress.toString()
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, crypto_utils_1.B64ToUint8Array(result)];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Queries logs with filter terms
     *
     * @param filter Filter terms
     * @return Uint8Array The corresponding result of the filter
     */
    Client.prototype.getEvmLogsAsync = function (filterObject) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var filter, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        filter = JSON.stringify(filterObject);
                        log("Send filter " + filter + " to getlogs");
                        return [4 /*yield*/, this._readClient.sendAsync('getevmlogs', {
                                filter: filter
                            })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, crypto_utils_1.B64ToUint8Array(result)];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Creates a new filter based on filter terms, to notify when the state changes
     *
     * The function getEVMNewFilterAsync works in the similar way of the RPC call eth_newFilter, for more
     *
     * Also for understand how filters works check https://github.com/ethereum/wiki/wiki/JSON-RPC#eth_newfilter
     *
     * @param filter Filter terms
     * @return Uint8Array The corresponding result of the filter
     */
    Client.prototype.newEvmFilterAsync = function (filterObject) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var filter, result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        filter = JSON.stringify(filterObject);
                        log("Send filter " + filter + " to newfilter");
                        return [4 /*yield*/, this._readClient.sendAsync('newevmfilter', {
                                filter: filter
                            })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, result];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Polling method for a filter, which returns an array of logs which occurred since last poll
     *
     * The ID used was requested from getEVMNewFilterChanges or getEVMNewBlockFilter
     *
     * @param id Id of filter previously created
     * @return Uint8Array The corresponding result of the request for given id
     */
    Client.prototype.getEvmFilterChangesAsync = function (id) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result, envelope;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        log("Get filter changes for " + JSON.stringify({ id: id }, null, 2));
                        return [4 /*yield*/, this._readClient.sendAsync('getevmfilterchanges', {
                                id: id
                            })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            envelope = evm_pb_1.EthFilterEnvelope.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(result));
                            switch (envelope.getMessageCase()) {
                                case evm_pb_1.EthFilterEnvelope.MessageCase.ETH_BLOCK_HASH_LIST:
                                    return [2 /*return*/, envelope.getEthBlockHashList()];
                                case evm_pb_1.EthFilterEnvelope.MessageCase.ETH_FILTER_LOG_LIST:
                                    return [2 /*return*/, envelope.getEthFilterLogList()];
                                case evm_pb_1.EthFilterEnvelope.MessageCase.ETH_TX_HASH_LIST:
                                    return [2 /*return*/, envelope.getEthTxHashList()];
                                case evm_pb_1.EthFilterEnvelope.MessageCase.MESSAGE_NOT_SET:
                                default:
                                    return [2 /*return*/, null];
                            }
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Creates a filter in the node, to notify when a new block arrives
     *
     * In order to check if the state has changed, call getEVMFilterChangesAsync
     *
     * @return String Filter ID in hex format to be used later with getEVMFilterChangesAsync
     */
    Client.prototype.newBlockEvmFilterAsync = function () {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('newblockevmfilter', {})];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, result.toString()];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Creates a filter in the node, to notify when new pending transactions arrive.
     *
     * In order to check if the state has changed, call getEVMFilterChangesAsync
     *
     * @return String Filter ID in hex format to be used later with getEVMFilterChangesAsync
     */
    Client.prototype.newPendingTransactionEvmFilterAsync = function () {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('newpendingtransactionevmfilter', {})];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, result.toString()];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Uninstall/delete previously created filters
     *
     * The ID used was requested from getEVMNewFilterChanges or getEVMNewBlockFilter
     *
     * @param id Id of filter previously created
     * @return boolean If true the filter is removed with success
     */
    Client.prototype.uninstallEvmFilterAsync = function (id) {
        return this._readClient.sendAsync('uninstallevmfilter', {
            id: id
        });
    };
    /**
     * Returns information about a block by block number.
     *
     * @param num Integer of a block number
     * @param full If true it returns the full transaction objects, if false only the hashes of the transactions
     */
    Client.prototype.getEvmBlockByNumberAsync = function (num, full) {
        if (full === void 0) { full = true; }
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('getevmblockbynumber', {
                            number: num,
                            full: full
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, evm_pb_1.EthBlockInfo.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(crypto_utils_1.B64ToUint8Array(result)))];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * Returns the information about a transaction requested by transaction hash.
     *
     * @param hash String with the hash of the transaction
     * @param full If true it returns the full transaction objects, if false only the hashes of the transactions
     */
    Client.prototype.getEvmBlockByHashAsync = function (hashHexStr, full) {
        if (full === void 0) { full = true; }
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var result;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('getevmblockbyhash', {
                            hash: Buffer.from(hashHexStr.slice(2), 'hex').toString('base64'),
                            full: full
                        })];
                    case 1:
                        result = _a.sent();
                        if (result) {
                            return [2 /*return*/, evm_pb_1.EthBlockInfo.deserializeBinary(crypto_utils_1.bufferToProtobufBytes(crypto_utils_1.B64ToUint8Array(result)))];
                        }
                        else {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/];
                }
            });
        });
    };
    /**
     * It works by subscribing to particular events. The node will return a subscription id.
     * For each event that matches the subscription a notification with relevant data is send
     * together with the subscription id.
     *
     * Possible methods:
     *  * "NewHeads": Fires a notification each time a new header is appended to the chain
     *  * "Logs": Returns logs that are included in new imported blocks and match the given filter criteria
     *
     * Example of a "filter" (JSON String) with method "logs":
     *  {
     *    "address": "0xa520fe7702b96808f7bbc0d4a233ed1468216cfd",
     *    "topics": ["0x238a0cb8bb633d06981248b822e7bd33c2a35a6089241d099fa519e361cab902"]
     *  }
     *
     * @param method Method selected to the filter, can be "newHeads" or "logs"
     * @param filter JSON string of the filter
     */
    Client.prototype.evmSubscribeAsync = function (method, filterObject) {
        var filter = JSON.stringify(filterObject);
        return this._readClient.sendAsync('evmsubscribe', {
            method: method,
            filter: filter
        });
    };
    /**
     * Subscriptions are cancelled method and the subscription id as first parameter.
     * It returns a bool indicating if the subscription was cancelled successful.
     *
     * @param id Id of subscription previously created
     * @return boolean If true the subscription is removed with success
     */
    Client.prototype.evmUnsubscribeAsync = function (id) {
        return this._readClient.sendAsync('evmunsubscribe', {
            id: id
        });
    };
    /**
     * Gets the number of the latest block
     *
     * @return The block height
     */
    Client.prototype.getBlockHeightAsync = function () {
        return this._readClient.sendAsync('getblockheight', {});
    };
    /**
     * Gets a nonce for the given public key.
     *
     * This should only be called by NonceTxMiddleware.
     *
     * @param key A hex encoded public key.
     * @return The nonce.
     */
    Client.prototype.getNonceAsync = function (key) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var _a;
            return tslib_1.__generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _a = parseInt;
                        return [4 /*yield*/, this._readClient.sendAsync('nonce', { key: key })];
                    case 1: return [2 /*return*/, _a.apply(void 0, [_b.sent(), 10])];
                }
            });
        });
    };
    /**
     * Tries to resolve a contract name to an address.
     *
     * @param contractName Name of a smart contract on a Loom DAppChain.
     * @returns Contract address, or null if a contract matching the given name wasn't found.
     */
    Client.prototype.getContractAddressAsync = function (contractName) {
        return tslib_1.__awaiter(this, void 0, void 0, function () {
            var addrStr;
            return tslib_1.__generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this._readClient.sendAsync('resolve', { name: contractName })];
                    case 1:
                        addrStr = _a.sent();
                        if (!addrStr) {
                            return [2 /*return*/, null];
                        }
                        return [2 /*return*/, address_1.Address.fromString(addrStr)];
                }
            });
        });
    };
    Client.prototype._emitContractEvent = function (url, event) {
        var error = event.error, result = event.result;
        if (error) {
            var eventArgs = { kind: ClientEvent.Error, url: url, error: error };
            this.emit(ClientEvent.Error, eventArgs);
        }
        else if (result) {
            log('Event', event.id, result);
            // Ugh, no built-in JSON->Protobuf marshaller apparently
            // https://github.com/google/protobuf/issues/1591 so gotta do this manually
            var eventArgs = {
                id: event.id,
                kind: ClientEvent.Contract,
                url: url,
                contractAddress: new address_1.Address(result.address.chain_id, new address_1.LocalAddress(crypto_utils_1.B64ToUint8Array(result.address.local))),
                callerAddress: new address_1.Address(result.caller.chain_id, new address_1.LocalAddress(crypto_utils_1.B64ToUint8Array(result.caller.local))),
                blockHeight: result.block_height,
                data: crypto_utils_1.B64ToUint8Array(result.encoded_body || '0x0'),
                topics: result.topics,
                transactionHash: result.tx_hash,
                transactionHashBytes: result.tx_hash ? crypto_utils_1.B64ToUint8Array(result.tx_hash) : new Uint8Array([])
            };
            this.emit(ClientEvent.Contract, eventArgs);
        }
    };
    Client.prototype._emitNetEvent = function (url, kind, error) {
        if (kind === ClientEvent.Error) {
            var eventArgs = { kind: kind, url: url, error: error };
            this.emit(kind, eventArgs);
        }
        else {
            var eventArgs = { kind: kind, url: url };
            this.emit(kind, eventArgs);
        }
    };
    return Client;
}(events_1.default));
exports.Client = Client;
//# sourceMappingURL=client.js.map