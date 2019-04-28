
const batchActions = require('redux-batched-actions').batchActions

const walletExternal = require('./wallet-external')

const configWallet = require('../config/wallet')

const utilsWallet = require('../utils')


module.exports = {
    appWorkerHandler: (store, event) => {
        
        var postback, msg, status
        if (configWallet.WALLET_ENV === "BROWSER") {
            postback = event.data.data
            msg = event.data.msg
            status = event.data.status
        }
        else {
            postback = event.data
            msg = event.msg
            status = event.status
        }

        const globalScope = utilsWallet.getMainThreadGlobalScope()
        const appWorker = globalScope.appWorker

        if (msg === 'REQUEST_STATE' && postback) {
            const stateItem = postback.stateItem
            switch (stateItem) {
                case 'ASSET': // request: displayable asset, by asset symbol
                    const stateKey = postback.stateKey
                    const context = postback.context
                    const storeState = store.getState()
                    if (storeState && storeState.wallet && storeState.wallet.assets) {
                        const asset = storeState.wallet.assets.find((p) => { return p.symbol === stateKey })
                        if (asset) { // response:
                            appWorker.postMessage({ msg: 'STATE_RESPONSE', status: 'RES', data: { 
                                stateItem, stateKey, value: { asset, wallet: storeState.wallet, ux: storeState.ux }, context
                            } }) 
                        }
                    }
                    break
            }
        }
        else if (msg === 'REQUEST_DISPATCH') {
            const dispatchType = postback.dispatchType
            const dispatchPayload = postback.dispatchPayload
            store.dispatch({ type: dispatchType, payload: dispatchPayload })
        }
    
        // asset store updates
        else if (msg === 'ASSET_UPDATE_FULL_INSIGHT') {
            const dispatchAction = walletExternal.getAddressFull_ProcessResult(postback.res, postback.asset, postback.addrNdx)
            if (dispatchAction !== null) {
                store.dispatch(dispatchAction)
            }
        }
        else if (msg === 'ASSET_UPDATE_FULL_ACCOUNT') { 
            const dispatchAction = walletExternal.getAddressFull_ProcessResult(postback.res, postback.asset, postback.addrNdx)
            if (dispatchAction !== null) {
                store.dispatch(dispatchAction)
            }
        }
        else if (msg === 'REQUEST_DISPATCH_BATCH') {
            const dispatchActions = postback.dispatchActions
            if (dispatchActions) {

                // alert on any enrich_tx actions for newly mined tx's
                const storeState = store.getState()
                if (storeState && storeState.wallet && storeState.wallet.assets) {
                    const enrichTxOps = dispatchActions.filter(p => { return p.type === 'WCORE_SET_ENRICHED_TXS' })
                    enrichTxOps.forEach(enrichTxOp => {
                        const asset = storeState.wallet.assets.find(p => p.symbol === enrichTxOp.payload.symbol)
                        if (asset && enrichTxOp.payload.txs) {
                            const local_txs = walletExternal.getAll_local_txs(asset)
                            const all_txs = walletExternal.getAll_txs(asset)
                            const assetTxs = [...all_txs, ...local_txs]

                            enrichTxOp.payload.txs.forEach(enrichTx => {
                                if (assetTxs.some(p => p.txid === enrichTx.txid && p.block_no == -1 && enrichTx.block_no != -1)) {
                                    if (asset.symbol === 'ETH' && enrichTx.erc20 !== undefined) {
                                        ; // eth erc20 tx: nop - ignore the eth tx, just notify on for the erc20
                                    }
                                    else {
                                        if (configWallet.WALLET_ENV === "BROWSER") {
                                            utils.showToastr({
                                                type: 'success',
                                                headline: `${asset.displaySymbol}: Confirmed TX`,
                                                info: `${asset.displayName} mined ${CONST.EMOJI_HAPPY_KITTY}`,
                                                txid: enrichTx.txid
                                            })
                                        }
                                    }
                                }
                            })
                        }
                    })
                }

                // update store, batched
                store.dispatch(batchActions(dispatchActions))
            }
        }
    }
}