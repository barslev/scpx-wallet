// Distributed under AGPLv3 license: see /LICENSE for terms. Copyright 2019-2020 Dominic Morris.

const Buffer = require('buffer').Buffer
const _ = require('lodash')
const pLimit = require('p-limit')
const WAValidator = require('scp-address-validator').validate
const bitgoUtxoLib = require('bitgo-utxo-lib')
const bitcoinJsLib = require('bitcoinjs-lib')
const bip32 = require('bip32')
const ethereumJsUtil = require('ethereumjs-util')
const bchAddr = require('bchaddrjs')

const actionsWallet = require('.')
const actionsWalletUtxo = require('./wallet-utxo')
const actionsWalletAccount = require('./wallet-account')

const configWallet = require('../config/wallet')
const configExternal = require('../config/wallet-external')

const apiDataContract = require('../api/data-contract')

const utilsWallet = require('../utils')

module.exports = { 

    //
    // issues appWorker requests to populate asset data (balances & tx's) for the loaded wallet
    //
    loadAllAssets: (p) => {

        const { bbSymbols_SocketReady, store } = p // todo - could make use of BB field to exclude BBv3 assets with known sockets down 
        if (!store) throw 'No store supplied'
        var storeState = store.getState()
        if (!storeState) throw 'Invalid store state'
        const wallet = storeState.wallet
        if (!wallet || !wallet.assets) throw 'No wallet supplied'
        
        console.time('loadAllAssets')
        utilsWallet.logMajor('green','white', `loadAllAssets...`, null, { logServerConsole: true })

        const appWorker = utilsWallet.getAppWorker()
        //const globalScope = utilsWallet.getMainThreadGlobalScope()

        return new Promise((resolve) => {

            // get initial sync (block) info, all assets
            wallet.assets.forEach(asset => {
                appWorker.postMessage({ msg: 'GET_SYNC_INFO', data: { symbol: asset.symbol } })
            })

            // fetch eth[_test] first -- erc20 fetches will then use eth's cached tx data in the indexeddb
            const ethAssets = wallet.assets.filter(p => p.symbol === 'ETH' || p.symbol === 'ETH_TEST')
            ethAssets.forEach(ethAsset => {
                appWorker.postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: ethAsset, wallet } })
                //globalScope.loaderWorkers[0].postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: ethAsset, wallet } })
            })

            // then fetch all others, except erc20s
            var erc20Assets = wallet.assets.filter(p => utilsWallet.isERC20(p))
            var otherAssets = wallet.assets.filter(p => (p.symbol !== 'ETH' && p.symbol !== 'ETH_TEST') && !utilsWallet.isERC20(p))
            appWorker.postMessage({ msg: 'REFRESH_MULTI_ASSET_FULL', data: { assets: otherAssets, wallet } })
            // otherAssets.forEach(otherAsset => {
            //     appWorker.postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: otherAsset, wallet } })
            //     //globalScope.loaderWorkers[1].postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: otherAsset, wallet } })
            // })

            // wait for eth[_test] fetch to finish 
            const eth_intId = setInterval(() => {
                storeState = store.getState()
                if (storeState && storeState.wallet && storeState.wallet.assets) {
                    var ethDone = false, ethTestDone = false
                    
                    const ethAsset = storeState.wallet.assets.find(p => p.symbol === 'ETH')
                    ethDone = ethAsset.lastAssetUpdateAt !== undefined
                    if (!ethDone) {
                        utilsWallet.warn(`Wallet - pollAllAddressBalances: waiting for ETH to finish...`)
                    }

                    const ethTestAsset = storeState.wallet.assets.find(p => p.symbol === 'ETH_TEST')
                    ethTestDone = ethTestAsset === undefined || ethTestAsset.lastAssetUpdateAt !== undefined
                    if (!ethTestDone) {
                        utilsWallet.warn(`Wallet - pollAllAddressBalances: waiting for ETH_TEST to finish...`)
                    }

                    // now fetch erc20s - they will use cached eth[_test] tx's
                    if (ethDone && ethTestDone) {
                        erc20Assets = wallet.assets.filter(p => utilsWallet.isERC20(p))
                        appWorker.postMessage({ msg: 'REFRESH_MULTI_ASSET_FULL', data: { assets: erc20Assets, wallet } })
                        // erc20Assets.forEach(erc20Asset => {
                        //     appWorker.postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: erc20Asset, wallet } })
                        //     //globalScope.loaderWorkers[3].postMessage({ msg: 'REFRESH_ASSET_FULL', data: { asset: erc20Asset, wallet } })
                        // })
                        clearInterval(eth_intId)

                        // now wait for all erc20 - and all other types - to finish
                        const allRemaining_intId = setInterval(() => {
                            storeState = store.getState()
                            if (storeState && storeState.wallet && storeState.wallet.assets) {

                                erc20Assets = storeState.wallet.assets.filter(p => utilsWallet.isERC20(p))
                                otherAssets = storeState.wallet.assets.filter(p => (p.symbol !== 'ETH' && p.symbol !== 'ETH_TEST') && !utilsWallet.isERC20(p))
                                if (!erc20Assets.some(p => p.lastAssetUpdateAt === undefined)
                                 && !otherAssets.some(p => p.lastAssetUpdateAt === undefined)) {

                                    // done
                                    clearInterval(allRemaining_intId)
                                    utilsWallet.logMajor('green','white', `loadAllAssets - complete`, null, { logServerConsole: true })
                                    console.timeEnd('loadAllAssets')
                                    resolve()
                                }
                                else {
                                    utilsWallet.warn(`Wallet - pollAllAddressBalances: waiting for ERC20s to finish...`)
                                }
                            }
                        }, 1000)
                    }
                }
            }, 1000)
        })
    },

    //
    // generates a new address (in the primary scoop account)
    //
    generateNewAddress: async (p) => {
        const { store, apk, h_mpk, assetName, // required - browser & server
                userAccountName, e_email,     // required - browser 
                eosActiveWallet } = p

        // validation
        if (!store) throw 'store is required'
        if (!apk) throw 'apk is required'
        if (!store) throw 'store is required'
        if (!h_mpk) throw 'h_mpk is required'
        if (configWallet.WALLET_ENV === "BROWSER") {
            if (!userAccountName) throw 'userAccountName is required'
            if (!e_email) throw 'e_email is required'
        }

        const storeState = store.getState()
        if (!storeState || !storeState.wallet || !storeState.wallet.assets || !storeState.wallet.assetsRaw) throw 'Invalid store state'
        const wallet = storeState.wallet
        const e_rawAssets = storeState.wallet.assetsRaw
        const displayableAssets = wallet.assets

        utilsWallet.logMajor('green','white', `generateNewAddress...`, null, { logServerConsole: true })

        // decrypt raw assets
        var pt_rawAssets = utilsWallet.aesDecryption(apk, h_mpk, e_rawAssets)
        var rawAssets = JSON.parse(pt_rawAssets)

        // get asset and account to generate into
        const genAsset = rawAssets[assetName.toLowerCase()]
        if (genAsset === undefined || !genAsset.accounts || genAsset.accounts.length == 0) throw 'Invalid assetName'
        const meta = configWallet.walletsMeta[assetName.toLowerCase()]
        const genSymbol = meta.symbol
        const genAccount = genAsset.accounts[0] // default (Scoop) account

        // generate new address
        var newPrivKey
        switch (meta.type) {
            case configWallet.WALLET_TYPE_UTXO:
                newPrivKey = generateUtxoBip44Wifs({
                    entropySeed: h_mpk, 
                         symbol: genSymbol, //genSymbol === 'BTC_SEG' || genSymbol === 'BTC_TEST' ? 'BTC' : genSymbol,
                        addrNdx: genAccount.privKeys.length,
                       genCount: 1 })[0]
                break
            
            case configWallet.WALLET_TYPE_ACCOUNT: 
                if (genSymbol === 'EOS') ; //todo
                else if (meta.addressType === configWallet.ADDRESS_TYPE_ETH) { // including erc20
                    newPrivKey = generateEthereumWallet({
                        entropySeed: h_mpk,
                            addrNdx: genAccount.privKeys.length, 
                           genCount: 1 })[0]
                }
                break
        }

        if (newPrivKey) {
            // add new priv key (assets raw)
            genAccount.privKeys.push(newPrivKey)
            
            var rawAssetsJsonUpdated = JSON.stringify(rawAssets, null, 4)
            const e_rawAssetsUpdated = utilsWallet.aesEncryption(apk, h_mpk, rawAssetsJsonUpdated)
            store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS_RAW, payload: e_rawAssetsUpdated })
            rawAssetsJsonUpdated = null

            // post to server
            if (userAccountName && configWallet.WALLET_ENV === "BROWSER") {
                await apiDataContract.updateAssetsJsonApi(
                    { owner: userAccountName, 
     encryptedAssetsJSONRaw: module.exports.encryptPrunedAssets(rawAssets, apk, h_mpk), 
                    e_email: e_email,
           showNotification: true })
            }

            // add new displayable asset address object
            const newDisplayableAssets = _.cloneDeep(displayableAssets)
            const newDisplayableAsset = newDisplayableAssets.find(p => { return p.symbol === genSymbol })

            const newDisplayableAddr = newWalletAddressFromPrivKey( {
                      assetName: assetName.toLowerCase(),
                    accountName: genAccount.name,
                            key: newPrivKey,
                eosActiveWallet: eosActiveWallet,
                      knownAddr: undefined,
                         symbol: newDisplayableAsset.symbol
            })

            newDisplayableAsset.addresses.push(newDisplayableAddr)
            store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS, payload: { assets: newDisplayableAssets, owner: userAccountName } })

            if (configWallet.WALLET_ENV === "BROWSER") {
                const globalScope = utilsWallet.getMainThreadGlobalScope()
                const appWorker = globalScope.appWorker    

                // update addr monitors
                appWorker.postMessage({ msg: 'DISCONNECT_ADDRESS_MONITORS', data: { wallet } })
                appWorker.postMessage({ msg: 'CONNECT_ADDRESS_MONITORS', data: { wallet } })
        
                // refresh asset balance
                appWorker.postMessage({ msg: 'REFRESH_ASSET_BALANCE', data: { asset: newDisplayableAsset, wallet } })
            }
            else {
                ; // nop
                // server is better placed to than here handle addr-monitor connection better 
            }
            
            // ret ok
            utilsWallet.softNuke(rawAssets); pt_rawAssets = null
            utilsWallet.logMajor('green','white', `generateNewAddress - complete`, null, { logServerConsole: true })
            return { newAddr: newDisplayableAddr, newCount: genAccount.privKeys.length }

        } else {
            // ret fail
            utilsWallet.softNuke(rawAssets); pt_rawAssets = null
            return { err: 'Failed to generate private key', newAddr: undefined }
        }
    },

    //
    // imports external privkeys into a new import account
    //
    importPrivKeys: async (p) => { 

        var { store, apk, h_mpk, assetName, addrKeyPairs,  // required - browser & server
              userAccountName, e_email,                             // required - browser 
              eosActiveWallet } = p

        // validation
        if (!store) throw 'store is required'
        if (!apk) throw 'apk is required'
        if (!assetName) throw 'assetName is required'
        if (!h_mpk) throw 'h_mpk is required'        
        if (!addrKeyPairs || addrKeyPairs.length == 0) throw 'addrKeyPairs required'
        if (configWallet.WALLET_ENV === "BROWSER") {
            if (!userAccountName) throw 'userAccountName is required'
            if (!e_email) throw 'e_email is required'
        }

        const storeState = store.getState()
        if (!storeState || !storeState.wallet || !storeState.wallet.assets || !storeState.wallet.assetsRaw) throw 'Invalid store state'
        const wallet = storeState.wallet
        const e_rawAssets = storeState.wallet.assetsRaw
        const displayableAssets = wallet.assets

        utilsWallet.logMajor('green','white', `importPrivKeys...`, null, { logServerConsole: true })

        // decrypt raw assets
        var pt_rawAssets = utilsWallet.aesDecryption(apk, h_mpk, e_rawAssets)
        var rawAssets = JSON.parse(pt_rawAssets)

        // get asset 
        const genAsset = rawAssets[assetName.toLowerCase()]
        if (genAsset === undefined || !genAsset.accounts || genAsset.accounts.length == 0) { throw 'Invalid asset' }
        const meta = configWallet.walletsMeta[assetName.toLowerCase()]
        const genSymbol = meta.symbol

        // remove already imported 
        var existingPrivKeys = []
        genAsset.accounts.forEach(account => {
            existingPrivKeys = existingPrivKeys.concat(account.privKeys)
        })
        addrKeyPairs = addrKeyPairs.filter(toImport => !existingPrivKeys.some(existing => existing.privKey === toImport.privKey))
        if (addrKeyPairs.length == 0) {
            utilsWallet.warn(`All supplied keys already imported`, null, { logServerConsole: true })
            return { importedAddrCount: 0  }
        }

        // make new HD account for import
        const existingImports = genAsset.importCount || 0 //genAsset.accounts.length - 1 // first account is default Scoop addresses
        const importAccount = { // new import account
            imported: true,
            name: `Import #${existingImports+1} ${meta.displayName}`,
            privKeys: []
        }
        genAsset.accounts.push(importAccount)
        const accountNdx = existingImports + 1 // imported accounts start at our HD index 1 (scoop default is 0)
        genAsset.importCount = accountNdx

        // map raw suplied priv keys to our internal format; note -- there is no "real" HD path for imported keys (they're not derived keys)
        // we use custom path prefix 'i' for imported to denote this
        const privKeys = []
        for (var i=0 ; i < addrKeyPairs.length ; i++) {
            const privKey = addrKeyPairs[i].privKey
            var chainNdx = 0 // bip44: 0=external chain, 1=internal chain (change addresses)
            privKeys.push({ privKey, path: `i/44'/${meta.bip44_index}'/${accountNdx}'/${chainNdx}/${i}` })
        }

        // add new priv keys
        privKeys.forEach(privKey => {
            importAccount.privKeys.push(privKey)
        })

        // update local persisted raw assets
        var rawAssetsJsonUpdated = JSON.stringify(rawAssets, null, 4)
        const e_rawAssetsUpdated = utilsWallet.aesEncryption(apk, h_mpk, rawAssetsJsonUpdated)
        store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS_RAW, payload: e_rawAssetsUpdated })
        rawAssetsJsonUpdated = null

        // add to displayable asset addresses - this fails inside .then() below; no idea why
        const newDisplayableAssets = _.cloneDeep(displayableAssets)
        const newDisplayableAsset = newDisplayableAssets.find(p => { return p.symbol === genSymbol })
        for (var i=0 ; i < addrKeyPairs.length ; i++) {
            const addr = addrKeyPairs[i].addr
            var newDisplayableAddr = newWalletAddressFromPrivKey( {
                  assetName: assetName.toLowerCase(),
                accountName: importAccount.name,
                        key: privKeys.find(p => p.privKey == addrKeyPairs[i].privKey),
            eosActiveWallet: eosActiveWallet,
                  knownAddr: addr,
                     symbol: newDisplayableAsset.symbol
            })
            if (newDisplayableAddr.addr === null) {
                utilsWallet.softNuke(rawAssets); utilsWallet.softNuke(genAsset); pt_rawAssets = null
                return { err: "Invalid private key" }
            }
            newDisplayableAsset.addresses.push(newDisplayableAddr)
        }
        store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS, payload: { assets: newDisplayableAssets, owner: userAccountName } })
        
        if (userAccountName && configWallet.WALLET_ENV === "BROWSER") {
            // raw assets: post encrypted
            await apiDataContract.updateAssetsJsonApi(
                { owner: userAccountName, 
 encryptedAssetsJSONRaw: module.exports.encryptPrunedAssets(rawAssets, apk, h_mpk), 
                e_email: e_email,
       showNotification: true })

            // update addr monitors
            window.appWorker.postMessage({ msg: 'DISCONNECT_ADDRESS_MONITORS', data: { wallet } })
            window.appWorker.postMessage({ msg: 'CONNECT_ADDRESS_MONITORS', data: { wallet } })

            // refresh asset balance
            window.appWorker.postMessage({ msg: 'REFRESH_ASSET_BALANCE', data: { asset: newDisplayableAsset, wallet } })
        }
        
        // ret ok
        utilsWallet.logMajor('green','white', `importPrivKeys - complete`, addrKeyPairs.length, { logServerConsole: true })
        utilsWallet.softNuke(rawAssets); utilsWallet.softNuke(genAsset); pt_rawAssets = null
        return { importedAddrCount: privKeys.length, accountName: importAccount.name }
    },

    //
    // removes imported account(s)
    //
    removeImportedAccounts: async (p) => {
        var { store, apk, h_mpk, assetName, removeAccounts,  // required - browser & server
              userAccountName, e_email,                      // required - browser 
              eosActiveWallet } = p

        // validation
        if (!store) throw 'store is required'
        if (!apk) throw 'apk is required'
        if (!assetName) throw 'assetName is required'
        if (!h_mpk) throw 'h_mpk is required'        
        if (!removeAccounts || removeAccounts.length == 0) throw 'removeAccounts required'
        if (configWallet.WALLET_ENV === "BROWSER") {
            if (!userAccountName) throw 'userAccountName is required'
            if (!e_email) throw 'e_email is required'
        }

        const storeState = store.getState()
        if (!storeState || !storeState.wallet || !storeState.wallet.assets || !storeState.wallet.assetsRaw) throw 'Invalid store state'
        const wallet = storeState.wallet
        const e_rawAssets = storeState.wallet.assetsRaw
        const displayableAssets = wallet.assets

        utilsWallet.logMajor('green','white', `removeImportedAccounts...`, removeAccounts, { logServerConsole: true })

        // decrypt raw assets
        var pt_rawAssets = utilsWallet.aesDecryption(apk, h_mpk, e_rawAssets)
        var rawAssets = JSON.parse(pt_rawAssets)

        // get asset 
        const genAsset = rawAssets[assetName.toLowerCase()]
        if (genAsset === undefined || !genAsset.accounts || genAsset.accounts.length == 0) { throw 'Invalid asset' }
        const meta = configWallet.walletsMeta[assetName.toLowerCase()]
        const genSymbol = meta.symbol

        // remove internal scoop accounts - we only remove externally imported accounts
        const importedAccountNames = genAsset.accounts.filter(p => p.imported == true).map(p => p.name)
        removeAccounts = removeAccounts.filter(p => importedAccountNames.some(p2 => p2 === p))
        if (removeAccounts == 0) {
            utilsWallet.warn(`No import accounts to remove`, null, { logServerConsole: true })
            return { removedAddrCount: 0, removedAccountCount: 0  }
        }

        // raw assets: remove specified accounts & addresses
        const removedAccountCount = genAsset.accounts.filter(p => removeAccounts.some(p2 => p2 === p.name) === true).length
        genAsset.accounts = genAsset.accounts.filter(p => removeAccounts.some(p2 => p2 === p.name) === false)
        genAsset.addresses = genAsset.addresses.filter(p => removeAccounts.some(p2 => p2 === p.accountName) === false)

        // raw assets: update local persisted copy
        var rawAssetsJsonUpdated = JSON.stringify(rawAssets, null, 4)
        const e_rawAssetsUpdated = utilsWallet.aesEncryption(apk, h_mpk, rawAssetsJsonUpdated)
        store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS_RAW, payload: e_rawAssetsUpdated })
        rawAssetsJsonUpdated = null

        // displayableAssets: remove specified accounts & addresses
        const newDisplayableAssets = _.cloneDeep(displayableAssets)
        const newDisplayableAsset = newDisplayableAssets.find(p => { return p.symbol === genSymbol })
        const removedAddrCount = newDisplayableAsset.addresses.filter(p => removeAccounts.some(p2 => p2 === p.accountName) === true).length
        newDisplayableAsset.addresses = newDisplayableAsset.addresses.filter(p => removeAccounts.some(p2 => p2 === p.accountName) === false)
        store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS, payload: { assets: newDisplayableAssets, owner: userAccountName } })

        if (userAccountName && configWallet.WALLET_ENV === "BROWSER") {
            // raw assets: post encrypted
            await apiDataContract.updateAssetsJsonApi(
                { owner: userAccountName, 
 encryptedAssetsJSONRaw: module.exports.encryptPrunedAssets(rawAssets, apk, h_mpk), 
                e_email: e_email,
       showNotification: true })

            // update addr monitors
            window.appWorker.postMessage({ msg: 'DISCONNECT_ADDRESS_MONITORS', data: { wallet } })
            window.appWorker.postMessage({ msg: 'CONNECT_ADDRESS_MONITORS', data: { wallet } })

            // refresh asset balance
            window.appWorker.postMessage({ msg: 'REFRESH_ASSET_BALANCE', data: { asset: newDisplayableAsset, wallet } })
        }

        // ret ok
        utilsWallet.logMajor('green','white', `removeImportedAccounts - complete`, removedAddrCount, { logServerConsole: true })
        utilsWallet.softNuke(rawAssets); utilsWallet.softNuke(genAsset); pt_rawAssets = null
        return { removedAddrCount, removedAccountCount }
    },

    //
    // generates a new scoop wallet, for all supported assets
    //
    // supplied e_storedAssetsRaw can originate from Data Storage Contract (DSC) (server and browser) or
    // from raw file store (server only);
    // 
    // if supplied, DSC data is decrypted, and any newly added asset types are merged with the DSC data to
    // preserve any previosuly imported accounts or added addresses
    //
    //  browser: merged data is re-encrypted and written back to the DSC
    //   server: merged data is persisted in-memory to redux store
    //
    generateWallets: async (p) => {
        const { store, userAccountName, e_storedAssetsRaw, eosActiveWallet, callbackProcessed, 
                apk, e_email, h_mpk, email } = p
        if (!store) { throw 'Invalid store' }
        if (!h_mpk) { throw 'Invalid h_mpk' }

        // decrypt existing raw assets, if supplied (either from server in client mode, or from file in server mode)
        var pt_storedRawAssets
        var currentAssets
        if (e_storedAssetsRaw !== undefined && e_storedAssetsRaw !== null && e_storedAssetsRaw !== '') {
            pt_storedRawAssets = utilsWallet.aesDecryption(apk, h_mpk, e_storedAssetsRaw)
            if (!pt_storedRawAssets || pt_storedRawAssets.length === 0) {
                return null // decrypt failed
            }
            currentAssets = JSON.parse(pt_storedRawAssets)
            
            utilsWallet.logMajor('green','white', 'GENERATING (GOT SERVER ASSETS)...')
        } else {
            utilsWallet.logMajor('green','white', 'GENERATING (NEW)...')
            currentAssets = {} // generate new
        }

        // determine what wallets to generate, if any
        const currentTypes = Object.keys(currentAssets)
        var supportWalletTypes = configWallet.getSupportedWalletTypes()
        var needToGenerate = configWallet.WALLET_REGEN_EVERYTIME
            ? supportWalletTypes
            : supportWalletTypes.filter(assetType => !currentTypes.includes(assetType))

        // temp/hack - conditional load of test assets, by email type
        if (email !== undefined) {
            //if (email !== 'testnets2@scoop.tech') {

                // remove test assets, unless logged into appropriate account
                if (!email.includes("aircarbon.co")) { 
                    console.warn('temp/dbg - skipping aircarbon(t) for non AC email account')
                    needToGenerate = needToGenerate.filter(p => p !== 'aircarbon(t)')
                }
                if (!email.includes("singdax.co")) { 
                    console.warn('temp/dbg - skipping singdax(t) for non SD email account')
                    needToGenerate = needToGenerate.filter(p => p !== 'singdax(t)')
                }
                if (!email.includes("ayondo.com")) { 
                    console.warn('temp/dbg - skipping ayondo(t) for non AY email account')
                    needToGenerate = needToGenerate.filter(p => p !== 'ayondo(t)')
                }
            //}

            // in prod, remove eth_test unless a test asset is present (excluding testnets account)
            if (email !== 'testnets2@scoop.tech') {
                //if (!configWallet.IS_DEV) {
                    if (!needToGenerate.some(p => p === 'aircarbon(t)' || p === 'singdax(t)' || p === 'ayondo(t)')) {
                        needToGenerate = needToGenerate.filter(p => p !== 'eth(t)')
                    }
                //}
            }
        }

        // (re)generate wallets
        // (all, if set by option, else only those assets not present in the server data, i.e. if a new account, or if we've added newly supported types)
        if (needToGenerate.length > 0) {

            utilsWallet.logMajor('green','white', `GENERATING ${needToGenerate.length} ASSET TYPE(s)...`, null, { logServerConsole: true })
            
            // DBG: ETH_T testnets dropping second address...
            //console.log(JSON.stringify(currentAssets['eth(t)'], null, 2))

            // inverse/remove: remove server assets no longer in client-side asset list
            const currentAssetNames = Object.keys(currentAssets)
            const currentAssetsToRemove = currentAssetNames.filter(p => needToGenerate.some(p2 => p === p2) === false)
            if (currentAssetsToRemove.length > 0) {
                utilsWallet.warn(`REMOVING ${currentAssetsToRemove.length} ASSETS TYPE(s) (NOT PRESENT IN CLIENT LIST)... ***`, currentAssetsToRemove)
                currentAssetsToRemove.forEach(removeAssetName => {
                    delete currentAssets[removeAssetName]
                })
            }

            // generate ETH first (ERC20 and ETH(T) will use its privkey)
            if (needToGenerate.includes('ethereum')) {
                var ret = generateWalletAccount({ assets: currentAssets, genType: 'ethereum', h_mpk })
                needToGenerate = needToGenerate.filter(p => p !== 'ethereum')
                //utilsWallet.log(`generateWallets - did ETH ret=${ret}, new needToGenerate=${JSON.stringify(needToGenerate)}`)
            }

            // generate the rest
            needToGenerate.forEach(genType => generateWalletAccount({ assets: currentAssets, genType, h_mpk, eosActiveWallet }))

            // create top-level addresses - w/ cpuWorkers
            // perf -- a flattened list of ops across all assets/accounts/keys
            // thottled-promise pattern, dispatch op to 1 of n cpuWorkers
            var opParams = []
            var reqId = 0
            Object.keys(currentAssets).forEach(function(assetName) {
                var o = currentAssets[assetName]
                if (configWallet.WALLET_REGEN_EVERYTIME || o.addresses == undefined) {
                    o.addresses = [] // initialize asset addresses[]
                    for (var i=0; i < o.accounts.length ; i++) {
                        const accountNdx = i
                        const accountOpParams = 
                            o.accounts[i].privKeys.map(key => ({
                                    reqId: `${reqId++}`,
                                   params: {
                                            symbol: configWallet.walletsMeta[assetName].symbol,
                                         assetName: assetName, 
                                       accountName: o.accounts[accountNdx].name,
                                               key: key, 
                                   eosActiveWallet: eosActiveWallet, 
                                         knownAddr: undefined,
                                }
                            } ))
                        opParams = opParams.concat(accountOpParams)
                    }
                }
            })

            const globalScope = utilsWallet.getMainThreadGlobalScope()
            const limit = pLimit(globalScope.CPU_WORKERS)
            opParams.forEach(p => p.totalReqCount = opParams.length)
            const results = await Promise.all(opParams.map(p => limit(() => utilsWallet.op_WalletAddrFromPrivKey(p, callbackProcessed))))

            const assetNames = Object.keys(currentAssets)
            results.forEach(function(addr) { // populate asset addresses[] with results
                for (var i=0 ; i < assetNames.length ; i++) {
                    const assetName = assetNames[i], assetMeta = configWallet.walletsMeta[assetName]
                    if (assetMeta.symbol === addr.symbol) {
                        currentAssets[assetName].addresses.push(addr)
                        break
                    }
                }
            })

            // log, all done 
            utilsWallet.logMajor('green', 'white', `FINISHED GENERATING ASSETS`, null, { logServerConsole: true })

            //
            // encrypt & postback raw asset data to server - potentially with newly added assets
            // 

            // persist raw encrypted to eos server - pruned raw assets (without addresss data)
            if (userAccountName && configWallet.WALLET_ENV === "BROWSER") {
                
                //await 
                apiDataContract.updateAssetsJsonApi({ 
                          owner: userAccountName, 
         encryptedAssetsJSONRaw: module.exports.encryptPrunedAssets(currentAssets, apk, h_mpk), 
                        e_email: e_email,
               showNotification: false
                })
                .catch(error => {
                    utilsWallet.log("ERROR #1.UA-APP CANNOT PROCESS UPDATE (" + error + ")")
                    let msg = "Unknown Error"
                    try {
                        msg = error.response.data.msg || error.message || "Unknown Error"
                    } catch (_) {
                        msg = error.message || "Unknown Error"
                    }
                })
            }

            // persist assets encrypted local - unpruned raw assets (private keys, with derived address data)
            var rawAssetsJsonUpdated = JSON.stringify(currentAssets, null, 4) 
            const e_rawAssetsUpdated = utilsWallet.aesEncryption(apk, h_mpk, rawAssetsJsonUpdated)
            store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS_RAW, payload: e_rawAssetsUpdated })
            rawAssetsJsonUpdated = null

        } else {
            utilsWallet.logMajor('green', 'white', `FINISHED LOAD & X-REF CHECK FOR ASSET TYPES...`)
            store.dispatch({ type: actionsWallet.WCORE_SET_ASSETS_RAW, payload: e_storedAssetsRaw }) // persist encrypted local - no changes
        }

        // ***
        // store local state: viewable asset data, e.g. last known balances: subset of currentAssets, persisted to browser storage, without privkeys
        // ***
        const displayableAssets = displayableWalletAssets(currentAssets, userAccountName)
        store.dispatch((action) => {
            action({ type: actionsWallet.WCORE_SET_ASSETS, payload: { assets: displayableAssets, owner: userAccountName } })
        })

        utilsWallet.softNuke(currentAssets)
        return displayableAssets
    },
    
    encryptPrunedAssets: (currentAssets, apk, h_mpk) => {
        // prune
        var currentAssetsKeysOnly = {} 
        Object.keys(currentAssets).map(assetName => {
            var assetAccounts = _.cloneDeep(currentAssets[assetName].accounts)
            currentAssetsKeysOnly[assetName] = { accounts: assetAccounts }
        })

        // stringify
        var pt_assetsJsonPruned = JSON.stringify(currentAssetsKeysOnly, null, 1)

        // encrypt
        const e_assetsRawPruned = utilsWallet.aesEncryption(apk, h_mpk, pt_assetsJsonPruned)

        utilsWallet.softNuke(currentAssetsKeysOnly)
        utilsWallet.softNuke(pt_assetsJsonPruned)
        return e_assetsRawPruned
    },

    //
    // get default/"generic" fees
    // should be deprecated/removed completely in favour of wallet-external.computeTxFee() [specific tx fee compute]
    //
    getAssetFeeData: (asset) => {
        //utilsWallet.log("fees - getAssetFeeData")
        switch (asset.type) {

            case configWallet.WALLET_TYPE_UTXO:
                return actionsWalletUtxo.estimateFees_Utxo(asset.symbol)
                .then(res => {
                    utilsWallet.log(`fees - (UTXO) getAssetFeeData - ${asset.symbol}, res=`, res)
                    return res
                })
                .catch(err => {
                    utilsWallet.error(`### fees - getAssetFeeData ${asset.symbol} FAIL - err=`, err)
                })
                break

            case configWallet.WALLET_TYPE_ACCOUNT:
                const estimateGasParams = {
                    from: asset.addresses[0].addr,
                      to: configExternal.walletExternal_config[asset.symbol].donate,
                   value: 1.0
                }

                return new Promise((resolve, reject) => {
                    const appWorker = utilsWallet.getAppWorker()
                    const listener = function(event) {
                        const input = utilsWallet.unpackWorkerResponse(event)
                        if (input) {
                            const msg = input.msg
                            if (msg === 'GET_ETH_TX_FEE_WEB3_DONE') {
                                const assetSymbol = input.data.assetSymbol
                                const fees = input.data.fees
                                if (assetSymbol === asset.symbol) {
                                    resolve(fees)
                                    appWorker.removeEventListener('message', listener)
                                }
                            } 
                        }
                    }
                    appWorker.addEventListener('message', listener)
                    appWorker.postMessage({ msg: 'GET_ETH_TX_FEE_WEB3', data: { asset, params: estimateGasParams } })
                })
                break

            default: utilsWallet.error(`fees - unsupported asset type ${asset.type}`)
        }
    },

    //
    // Get bitcoin-js / bitgo-utxo-lib network object for supplied
    //
    getUtxoNetwork: (symbol) => {
        return getUtxoNetwork(symbol)
    },

    //
    // PrivKey -> Address (all types)
    //
    getAddressFromPrivateKey: (p) => {
        return getAddressFromPrivateKey(p)
    },

    //
    // for safe mapping to displayable wallet assets - keyed by path on underlying encrypted privKey
    //
    newWalletAddressFromPrivKey: (p) => {
        return newWalletAddressFromPrivKey(p)
    },

    //
    // address validation
    //
    validateAssetAddress: (p) => {
        var { testSymbol, testAddressType, validateAddr } = p
        if (!testSymbol || testSymbol.length == 0) throw 'testSymbol is required'
        if (!testAddressType || testAddressType.length == 0) throw 'testAddressType is required'
        if (testAddressType === 'BECH32') testAddressType = 'BTC'

        if (testSymbol === 'BCHABC') { // BCH: to legacy addr for validation
            if (validateAddr && validateAddr.length > 0) {
                try {
                    if (bchAddr.isCashAddress(validateAddr) || bchAddr.isBitpayAddress(validateAddr)) {
                        validateAddr = bchAddr.toLegacyAddress(validateAddr)
                    }
                }
                catch(err) {
                    console.warn(`## bchAddr.toLegacyAddress, err=`, err)
                }
            }
        }

        const isValid = WAValidator(validateAddr, testAddressType, testSymbol.includes('TEST') ? 'testnet' : 'prod')

        // fixed in scp-address-validator
        // if (testSymbol === 'VTC') { // WAValidator doesnt' recognize VTC 3-addresses
        //     if (!isValid) {
        //         if (validateAddr.startsWith('3') && validateAddr.length == 34) { // gross hack -- need to do this properly
        //             return true
        //         }
        //     }
        // }

        return isValid
    }
}

//
// wallet generation
// https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki
//
function generateWalletAccount(p) {
    const { assets, genType, h_mpk, eosActiveWallet } = p
    
    var asset = assets[genType]
    if (asset !== undefined) {
        utilsWallet.log(`generateWalletAccount - genType=${genType} EXISTING asset.accounts[0].privKeys.length=${assets[genType].accounts[0].privKeys.length}`, null, { logServerConsole: true })
    }
    else {
        utilsWallet.log(`generateWalletAccount - genType=${genType} NEW DEFAULT ASSET`, null, { logServerConsole: true })
    }

    var defaultPrivKeys

    switch (genType) {
        case 'btc(t)':   defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'BTC_TEST' }); break; 

        case 'bitcoin':  defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'BTC' }); break; 
        case 'btc(s)':   defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'BTC_SEG' }); break; 
        case 'btc(s2)':  defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'BTC_SEG2' }); break; 
        case 'litecoin': defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'LTC' }); break; 
        case 'zcash':    defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'ZEC' }); break; 
        case 'dash':     defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'DASH' }); break; 
        case 'vertcoin': defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'VTC' }); break;
        case 'qtum':     defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'QTUM' }); break;
        case 'digibyte': defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'DGB' }); break;
        case 'bchabc':   defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'BCHABC' }); break;

        case 'raven':    defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'RVN' }); break;

        case 'ethereum': defaultPrivKeys = generateEthereumWallet({ entropySeed: h_mpk, addrNdx: 0, genCount: configWallet.WALLET_DEFAULT_ADDRESSES }); break

        case 'ltc(t)':   defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'LTC_TEST' }); break; 
        case 'zcash(t)': defaultPrivKeys = generateUtxoBip44Wifs({ entropySeed: h_mpk, symbol: 'ZEC_TEST' }); break; 

        case 'eos':
            //utilsWallet.log(`eos=`, eosActiveWallet)
            if (eosActiveWallet) {
                const meta = configWallet.getMetaBySymbol('EOS')
                defaultPrivKeys = [{ privKey: eosActiveWallet.wif, path: `m/44'/${meta.bip44_index}'/0'/0/0` }];
            }
            break

        default:
            // erc20's and eth_test
            const meta = configWallet.walletsMeta[genType];
            if (meta == undefined) {
                console.warn('## missing meta for ' + genType, configWallet.walletsMeta)
            }
            if (configWallet.walletsMeta[genType].addressType === configWallet.ADDRESS_TYPE_ETH) {
                defaultPrivKeys = 
                    //assets['ethereum'].accounts !== undefined ?
                        assets['ethereum'].accounts[0].privKeys.slice()
                    //: [{ privKey: assets['ethereum'].wif }] // ###### race? - old path?
            }
            break
    }

    if (defaultPrivKeys !== undefined) { // save only the wifs/privkeys
        const accountName = `${configWallet.walletsMeta[genType].displayName}`

        if (asset === undefined) {
            // no existing server data: first-time creation
            asset = { accounts: [] }    
            asset.accounts.push({ // new default asset account
                name: accountName,
            privKeys: []
            })
            asset.accounts[0].privKeys = defaultPrivKeys.slice() // new asset default address indexes
            assets[genType] = asset
        } else {
            // we are "merging" (actually, replacing/overwriting) existing server data in the default account's default address indexes;
            // this isn't strictly necessary, as the server already has recorded and sent us the default indexes, but in the interests
            // of being strictly deterministic:
            for (var ndx=0 ; ndx < defaultPrivKeys.length ; ndx++) {
                asset.accounts[0].privKeys[ndx] = defaultPrivKeys[ndx]
            }
            // note: we leave any other server-populated address indexes alone, so any user-activated (non-default) addresses persist across logins

            // we reset the account name received from the server, too:
            asset.accounts[0].name = accountName
        }
        return true
    }
    return false
}

// creates wallet.assets[] safe/displayable core wallet data
function displayableWalletAssets(assets) {
    var displayableAssets = []
    if (assets) {
        for (const key in assets) {
            if (!configWallet.getSupportedWalletTypes().includes(key)) continue
            if (assets[key]) {
                var displayableAsset = Object.assign(
                    { addresses: assets[key].addresses, local_txs: [], },
                    configWallet.walletsMeta[key])

                displayableAssets.push(displayableAsset)
            }
        }
    }
    return displayableAssets
}

//
// general
//
function newWalletAddressFromPrivKey(p) {
    const { assetName, accountName, key, eosActiveWallet, knownAddr, symbol } = p
    
    var addr = !knownAddr ? getAddressFromPrivateKey(
                    { assetMeta: configWallet.walletsMeta[assetName], privKey: key.privKey, eosActiveWallet }
                )
              : knownAddr // perf (bulk import) - don't recompute the key if it's already been done

    return {
        symbol,
        addr, 
        accountName, 
        path: key.path, // see config/wallet -- we don't have completely unique HD paths (e.g. BTC/SW, and testnets), but seems not to matter too much (?)
        txs: [],
        utxos: [],
        lastAddrFetchAt: undefined,
    }
}

function getAddressFromPrivateKey(p) {
    const { assetMeta, privKey, eosActiveWallet } = p

    if (assetMeta.type === configWallet.WALLET_TYPE_UTXO) {
        return getUtxoTypeAddressFromWif(privKey, assetMeta.symbol)
    }

    else if (assetMeta.type === configWallet.WALLET_TYPE_ACCOUNT) {
        return getAccountTypeAddress(privKey, assetMeta.symbol, eosActiveWallet)
    }

    else utilsWallet.warn('### Wallet type ' + assetMeta.type + ' not supported!')
}

function getUtxoNetwork(symbol) {

    // https://github.com/BitGo/bitgo-utxo-lib/blob/master/src/networks.js
    // https://www.npmjs.com/package/@upincome/coininfo
    // https://github.com/libbitcoin/libbitcoin-system/wiki/Altcoin-Version-Mappings
    // https://github.com/libbitcoin/libbitcoin-system/issues/319

    // https://github.com/bitcoinjs/bitcoinjs-lib/issues/1067

    const coininfo = require('coininfo')
    switch (symbol) { 
        case "BTC":      return bitgoUtxoLib.networks.bitcoin
        case "BTC_SEG":  return bitgoUtxoLib.networks.bitcoin
        case "BTC_SEG2": return bitgoUtxoLib.networks.bitcoin
        case "BTC_TEST": return bitgoUtxoLib.networks.testnet

        case "LTC":      return bitgoUtxoLib.networks.litecoin
        case "LTC_TEST": return coininfo('LTC-TEST').toBitcoinJS()

        case "ZEC":      return bitgoUtxoLib.networks.zcash
        case "ZEC_TEST": return bitgoUtxoLib.networks.zcashTest

        case "DASH":     return bitgoUtxoLib.networks.dash
        case "BCHABC":   return bitgoUtxoLib.networks.bitcoincash
        case "VTC":      return coininfo('VTC').toBitcoinJS()
        case "QTUM":     return coininfo('QTUM').toBitcoinJS()
        case "DGB":
            var ret = coininfo('DGB')
            ret.versions.bip32 = { public: 0x0488B21E, private: 0x0488ADE4 }
            var ret_js = ret.toBitcoinJS()
            return ret_js

        case "RVN":      return coininfo('RVN').toBitcoinJS()

        default:
            return undefined
    }
}

//
// account types
//
function generateEthereumWallet(p) {
    const { entropySeed, addrNdx = 0, genCount = configWallet.WALLET_DEFAULT_ADDRESSES } = p

    try {
        var privKeys = []
        const root = bip32.fromSeed(Buffer.from(utilsWallet.hextoba(utilsWallet.sha256_shex(entropySeed))))
        var meta = configWallet.getMetaBySymbol('ETH')
        var accountNdx = 0 // scoop default account
        var chainNdx = 0   // bip44: 0=external chain, 1=internal chain (change addresses)
        for (var i = addrNdx; i < addrNdx + genCount; i++) {
            const path = `m/44'/${meta.bip44_index}'/${accountNdx}'/${chainNdx}/${i}`
            const child = root.derivePath(path)
            utilsWallet.debug(`generateEthereumWallet - ETH @ BIP44 path ${path}`)
            privKeys.push({ privKey: utilsWallet.batohex(child.privateKey), path })
        }
        return privKeys
    }
    catch (err) { 
        utilsWallet.error(`generateEthereumWallet - FAIL: ${err.message}`, err)
        return null
    }
}

function getAccountTypeAddress(privKey, symbol, eosActiveWallet) {
    //utilsWallet.log(`getAccountTypeAddress privKey=${privKey} symbol=${symbol}...`)
    try {
        if (symbol === "EOS") {
            if (eosActiveWallet !== undefined && eosActiveWallet !== null) {
                return eosActiveWallet.address
            }
            else {
                utilsWallet.warn(`## getAccountTypeAddress - eosActiveWallet undefined!`)
                return undefined
            }
        }
        else {
            return "0x" + ethereumJsUtil.privateToAddress(Buffer.from(utilsWallet.hextoba(privKey), 'hex')).toString('hex')
        }
    }
    catch (err) {
        utilsWallet.error(`getAccountTypeAddress - FAIL: ${err.message}`, err)
        return null
    }
}

//
// utxo types
//
function generateUtxoBip44Wifs(p) { 
    const { entropySeed, symbol, addrNdx = 0, genCount = configWallet.WALLET_DEFAULT_ADDRESSES } = p

    var keyPairs = []
    const network = getUtxoNetwork(symbol) // bitgo
    if (network === undefined) throw 'generateUtxoBip44Wifs - unsupported type'

    var meta = configWallet.getMetaBySymbol(symbol)

    const entropySha256 = utilsWallet.sha256_shex(entropySeed)
    var root = bitgoUtxoLib.HDNode.fromSeedHex(entropySha256, network) // bitgo HDNode 

    var accountNdx = 0 // scoop default account
    var chainNdx = 0   // bip44: 0=external chain, 1=internal chain (change addresses)
    for (var i = addrNdx; i < addrNdx + genCount; i++) {
        const path = `m/44'/${meta.bip44_index}'/${accountNdx}'/${chainNdx}/${i}`
        const child = root.derivePath(path)

        //var keyPair = ECPair.fromPrivateKey(child.privateKey, { network }) // bitcoin-js (no ZEC support, see https://github.com/bitcoinjs/bitcoinjs-lib/issues/865)
        var keyPair = child.keyPair // bitgo

        var wif = keyPair.toWIF()
        utilsWallet.debug(`generateUtxoBip44Wifs - ${symbol} @ BIP44 path ${path}`)
        keyPairs.push({ privKey: wif, path })
    }
    return keyPairs
}

function getUtxoTypeAddressFromWif(wif, symbol) {
    try {
        const network = getUtxoNetwork(symbol) // bitgo networks: supports ZEC UInt16 pubKeyHash || scriptHash

        const keyPair = bitgoUtxoLib.ECPair.fromWIF(wif, network) // bitgo ECPair, below: .getPublicKeyBuffer() instead of .publicKey in bitcoin-js

        if (symbol === "BTC" || symbol === "LTC" || symbol === "BTC_TEST" || symbol === "LTC_TEST") {
            // bitcoinjs-lib

            // legacy addr
            const { address } = bitcoinJsLib.payments.p2pkh({ pubkey: keyPair.getPublicKeyBuffer(), network }) // bitcoin-js payments (works with bitgo networks)
            return address
        }
        else if (symbol === "BTC_SEG") {
            // bitcoinjs-lib

            // native segwit - BlockCypher throws errors on address_balance -- generated bc1 addr isn't viewable on any block explorers!
            //const { address } = bitcoinJsLib.payments.p2wpkh({ pubkey: keyPair.publicKey, network })
            //return address

            // p2sh-wrapped segwit -- need to generate tx json entirely, blockcypher doesn't support
            // const { address } = bitcoinJsLib.payments.p2sh({ redeem: payments.p2wpkh({ pubkey: keyPair.publicKey, network }) })
            // return address

            // p2sh-wrapped segwit -- p2sh(p2wpkh) addr -- w/ bitcoinjsLib (3 addr)
            const { address } = bitcoinJsLib.payments.p2sh({ redeem: bitcoinJsLib.payments.p2wpkh({ pubkey: keyPair.getPublicKeyBuffer(), network }), network })
            return address
        }
        else if (symbol === "BTC_SEG2") {
            // unwrapped P2WPKH -- w/ bitgoUtxoLib -- native SW (b addr)
            var pubKey = keyPair.getPublicKeyBuffer()
            var scriptPubKey = bitgoUtxoLib.script.witnessPubKeyHash.output.encode(bitgoUtxoLib.crypto.hash160(pubKey))
            var address = bitgoUtxoLib.address.fromOutputScript(scriptPubKey)
            return address
        }
        else { 
            // bitgo-utxo-lib (note - can't use bitcoin-js payment.p2pkh with ZEC UInt16 pubKeyHash || scriptHash)

            var addr = keyPair.getAddress()
            if (symbol === 'BCHABC') {
                if (addr.startsWith('1')) {
                    addr = bchAddr.toCashAddress(addr)
                }
            }
            return addr
        }
    }
    catch (err) { 
        utilsWallet.error(`getUtxoTypeAddressFromWif - FAIL: ${err.message}`, err)
        return null
    }
}