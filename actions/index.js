// Distributed under AGPLv3 license: see /LICENSE for terms. Copyright 2019-2020 Dominic Morris.

module.exports = {

    // Core Wallet
    WCORE_SET_ASSETS: "WCORE_SET_ASSETS",         // displayable (safe, no privkey) wallet assets
    WCORE_SET_ASSETS_RAW: "WCORE_SET_ASSETS_RAW", // internal encrypted wallet raw assets (w/ sub-asset privkeys) 
    WCORE_SET_ADDRESS_FULL: "WCORE_SET_ADDRESS_FULL",
    WCORE_SET_ADDRESSES_FULL_MULTI: "WCORE_SET_ADDRESSES_FULL_MULTI",
    WCORE_SET_ENRICHED_TXS: "WCORE_SET_ENRICHED_TXS",
    WCORE_SET_ENRICHED_TXS_MULTI: "WCORE_SET_ENRICHED_TXS_MULTI",
    WCORE_PUSH_LOCAL_TX: "WCORE_PUSH_LOCAL_TX",

    // SyncInfo
    SET_ASSET_BLOCK_INFO: "SET_ASSET_BLOCK_INFO",

    // Prices
    PRICE_SOCKET_CONNECTED: "PRICE_SOCKET_CONNECTED",
    PRICE_SOCKET_DISCONNECTED: "PRICE_SOCKET_DISCONNECTED",
    BTC_PRICE_UPDATE: "BTC_PRICE_UPDATE",
    ETH_PRICE_UPDATE: "ETH_PRICE_UPDATE",
    EOS_PRICE_UPDATE: "EOS_PRICE_UPDATE",
    LTC_PRICE_UPDATE: "LTC_PRICE_UPDATE",
    ZEC_PRICE_UPDATE: "ZEC_PRICE_UPDATE",
    DASH_PRICE_UPDATE: "DASH_PRICE_UPDATE",
    VTC_PRICE_UPDATE: "VTC_PRICE_UPDATE",
    QTUM_PRICE_UPDATE: "QTUM_PRICE_UPDATE",
    DGB_PRICE_UPDATE: "DGB_PRICE_UPDATE",
    BCH_PRICE_UPDATE: "BCH_PRICE_UPDATE",
    
    RVN_PRICE_UPDATE: "RVN_PRICE_UPDATE",

    TUSD_PRICE_UPDATE: "TUSD_PRICE_UPDATE",
    BNT_PRICE_UPDATE: "BNT_PRICE_UPDATE",
    ZRX_PRICE_UPDATE: "ZRX_PRICE_UPDATE",
    BAT_PRICE_UPDATE: "BAT_PRICE_UPDATE",
    BNB_PRICE_UPDATE: "BNB_PRICE_UPDATE",
    OMG_PRICE_UPDATE: "OMG_PRICE_UPDATE",
    GTO_PRICE_UPDATE: "GTO_PRICE_UPDATE",
    SNT_PRICE_UPDATE: "SNT_PRICE_UPDATE",
    HT_PRICE_UPDATE: "HT_PRICE_UPDATE",
    USDT_PRICE_UPDATE: "USDT_PRICE_UPDATE",
    EURT_PRICE_UPDATE: "EURT_PRICE_UPDATE",
    LINK_PRICE_UPDATE: "LINK_PRICE_UPDATE",
    ZIL_PRICE_UPDATE: "ZIL_PRICE_UPDATE",
    HOT_PRICE_UPDATE: "HOT_PRICE_UPDATE",
    REP_PRICE_UPDATE: "REP_PRICE_UPDATE",
    MKR_PRICE_UPDATE: "MKR_PRICE_UPDATE",
    NEXO_PRICE_UPDATE: "NEXO_PRICE_UPDATE",

    FIAT_RATES_UPDATE: "FIAT_RATES_UPDATE",
    
    getPriceUpdateDispatchType: (symbol) => { return symbol.toUpperCase()+'_PRICE_UPDATE' },

    // Exchange
    XS_SET_EXCHANGE_ASSET: "XS_SET_EXCHANGE_ASSET",
    XS_SET_RECEIVE_ASSET: "XS_SET_RECEIVE_ASSET",
    XS_SET_MINMAX_AMOUNT: "XS_SET_MINMAX_AMOUNT",
    XS_SET_EST_RECEIVE_AMOUNT: "XS_SET_EST_RECEIVE_AMOUNT",
    XS_SET_FIXED_RECEIVE_AMOUNT: "XS_SET_FIXED_RECEIVE_AMOUNT",
    XS_UPDATE_EXCHANGE_TX: "XS_UPDATE_EXCHANGE_TX",
    XS_UPDATE_EXCHANGE_STATUS: "XS_UPDATE_EXCHANGE_STATUS",
    XS_SET_CURRENCIES: "XS_SET_CURRENCIES"
}