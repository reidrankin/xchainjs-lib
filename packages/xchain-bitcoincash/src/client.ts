const bitcash = require('@psf/bitcoincashjs-lib')

import * as utils from './utils'
import {
  RootDerivationPaths,
  Address,
  Balance,
  Network,
  Fees,
  Tx,
  TxParams,
  TxHash,
  TxHistoryParams,
  TxsPage,
  XChainClient,
  XChainClientParams,
} from '@xchainjs/xchain-client'
import { validatePhrase, getSeed } from '@xchainjs/xchain-crypto'
import { FeesWithRates, FeeRate, FeeRates, ClientUrl } from './types/client-types'
import { KeyPair } from './types/bitcoincashjs-types'
import { getTransaction, getAccount, getTransactions, getSuggestedFee } from './haskoin-api'
import { NodeAuth } from './types'
import { broadcastTx } from './node-api'

/**
 * BitcoinCashClient Interface
 */
interface BitcoinCashClient {
  getFeesWithRates(memo?: string): Promise<FeesWithRates>
  getFeesWithMemo(memo: string): Promise<Fees>
  getFeeRates(): Promise<FeeRates>
}

export type ClientParams = XChainClientParams & {
  haskoinUrl?: ClientUrl
  nodeUrl?: ClientUrl
  nodeAuth?: NodeAuth
  rootPath?: string
  index?: number
}
export type BitcoinCashClientParams = ClientParams // backwards compat

/**
 * Custom Bitcoin Cash client
 */
class Client implements BitcoinCashClient, XChainClient {
  private network: Network
  private phrase = ''
  private haskoinUrl: ClientUrl
  private nodeUrl: ClientUrl
  private nodeAuth?: NodeAuth
  private rootDerivationPaths: RootDerivationPaths

  /**
   * Constructor
   * Client is initialised with network type
   *
   * @param {ClientParams} params
   */
  protected constructor({
    network = 'testnet',
    haskoinUrl = {
      testnet: 'https://api.haskoin.com/bchtest',
      mainnet: 'https://api.haskoin.com/bch',
    },
    nodeUrl = {
      testnet: 'https://testnet.bch.thorchain.info',
      mainnet: 'https://bch.thorchain.info',
    },
    nodeAuth = {
      username: 'thorchain',
      password: 'password',
    },
    rootDerivationPaths = {
      mainnet: `m/44'/145'/0'/0/`,
      testnet: `m/44'/1'/0'/0/`,
    },
  }: ClientParams) {
    this.network = network
    this.haskoinUrl = haskoinUrl
    this.nodeUrl = nodeUrl
    this.rootDerivationPaths = rootDerivationPaths
    this.nodeAuth =
      // Leave possibility to send requests without auth info for user
      // by strictly passing nodeAuth as null value
      nodeAuth === null ? undefined : nodeAuth
  }

  static async create(params: ClientParams): Promise<Client> {
    const out = new Client(params)
    if (params.phrase !== undefined) await out.setPhrase(params.phrase)
    return out
  }

  /**
   * Set/Update the haskoin url.
   *
   * @param {string} url The new haskoin url.
   * @returns {void}
   */
  setHaskoinURL = (url: ClientUrl): void => {
    this.haskoinUrl = url
  }

  /**
   * Get the haskoin url.
   *
   * @returns {string} The haskoin url based on the current network.
   */
  getHaskoinURL = async (): Promise<string> => {
    return this.haskoinUrl[await this.getNetwork()]
  }

  /**
   * Set/Update the node url.
   *
   * @param {string} url The new node url.
   * @returns {void}
   */
  setNodeURL = (url: ClientUrl): void => {
    this.nodeUrl = url
  }

  /**
   * Get the node url.
   *
   * @returns {string} The node url for thorchain based on the current network.
   */
  getNodeURL = async (): Promise<string> => {
    return this.nodeUrl[await this.getNetwork()]
  }

  /**
   * Set/update a new phrase.
   *
   * @param {string} phrase A new phrase.
   * @param {string} derivationPath bip44 derivation path
   * @returns {Address} The address from the given phrase
   *
   * @throws {"Invalid phrase"}
   * Thrown if the given phase is invalid.
   */
  setPhrase = async (phrase: string, walletIndex = 0): Promise<Address> => {
    if (!validatePhrase(phrase)) throw new Error('Invalid phrase')
    this.phrase = phrase
    return await this.getAddress(walletIndex)
  }

  /**
   * Purge client.
   *
   * @returns {void}
   */
  purgeClient = async (): Promise<this> => {
    this.phrase = ''
    return this
  }

  /**
   * Set/update the current network.
   *
   * @param {Network} network `mainnet` or `testnet`.
   * @returns {void}
   *
   * @throws {"Network must be provided"}
   * Thrown if network has not been set before.
   */
  setNetwork = async (net: Network): Promise<this> => {
    if (!net) {
      throw new Error('Network must be provided')
    }
    this.network = net
    return this
  }

  /**
   * Get the current network.
   *
   * @returns {Network} The current network. (`mainnet` or `testnet`)
   */
  getNetwork = async (): Promise<Network> => {
    return this.network
  }

  /**
   * Get the explorer url.
   *
   * @returns {string} The explorer url based on the network.
   */
  getExplorerUrl = async (): Promise<string> => {
    const networkPath = utils.isTestnet(this.network) ? 'bch-testnet' : 'bch'
    return `https://www.blockchain.com/${networkPath}`
  }

  /**
   * Get the explorer url for the given address.
   *
   * @param {Address} address
   * @returns {string} The explorer url for the given address based on the network.
   */
  getExplorerAddressUrl = async (address: Address): Promise<string> => {
    return `${await this.getExplorerUrl()}/address/${address}`
  }

  /**
   * Get the explorer url for the given transaction id.
   *
   * @param {string} txID The transaction id
   * @returns {string} The explorer url for the given transaction id based on the network.
   */
  getExplorerTxUrl = async (txID: string): Promise<string> => {
    return `${await this.getExplorerUrl()}/tx/${txID}`
  }

  /**
   * @private
   * Get private key.
   *
   * Private function to get keyPair from the this.phrase
   *
   * @param {string} phrase The phrase to be used for generating privkey
   * @param {string} derivationPath BIP44 derivation path
   * @returns {PrivateKey} The privkey generated from the given phrase
   *
   * @throws {"Invalid phrase"} Thrown if invalid phrase is provided.
   * */
  private getBCHKeys = (phrase: string, derivationPath: string): KeyPair => {
    try {
      const rootSeed = getSeed(phrase)
      const masterHDNode = bitcash.HDNode.fromSeedBuffer(rootSeed, utils.bchNetwork(this.network))

      return masterHDNode.derivePath(derivationPath).keyPair
    } catch (error) {
      throw new Error(`Getting key pair failed: ${error?.message || error.toString()}`)
    }
  }

  /**
   * Get the current address.
   *
   * Generates a network-specific key-pair by first converting the buffer to a Wallet-Import-Format (WIF)
   * The address is then decoded into type P2WPKH and returned.
   *
   * @returns {Address} The current address.
   *
   * @throws {"Phrase must be provided"} Thrown if phrase has not been set before.
   * @throws {"Address not defined"} Thrown if failed creating account from phrase.
   */
  getAddress = async (index = 0): Promise<Address> => {
    if (this.phrase) {
      try {
        const keys = this.getBCHKeys(this.phrase, this.getFullDerivationPath(index))
        const address = keys.getAddress(index)

        return utils.stripPrefix(utils.toCashAddress(address))
      } catch (error) {
        throw new Error('Address not defined')
      }
    }

    throw new Error('Phrase must be provided')
  }

  /**
   * Get getFullDerivationPath
   *
   * @param {number} index the HD wallet index
   * @returns {string} The derivation path based on the network.
   */
  getFullDerivationPath(index: number): string {
    return this.rootDerivationPaths[this.network] + `${index}`
  }

  /**
   * Validate the given address.
   *
   * @param {Address} address
   * @returns {boolean} `true` or `false`
   */
  validateAddress = async (address: string): Promise<boolean> => {
    return utils.validateAddress(address, this.network)
  }

  /**
   * Get the BCH balance of a given address.
   *
   * @param {Address} address By default, it will return the balance of the current wallet. (optional)
   * @returns {Array<Balance>} The BCH balance of the address.
   *
   * @throws {"Invalid address"} Thrown if the given address is an invalid address.
   */
  getBalance = async (address: Address): Promise<Balance[]> => {
    return utils.getBalance({ haskoinUrl: await this.getHaskoinURL(), address })
  }

  /**
   * Get transaction history of a given address with pagination options.
   * By default it will return the transaction history of the current wallet.
   *
   * @param {TxHistoryParams} params The options to get transaction history. (optional)
   * @returns {TxsPage} The transaction history.
   *
   * @throws {"Invalid address"} Thrown if the given address is an invalid address.
   */
  getTransactions = async ({ address, offset, limit }: TxHistoryParams): Promise<TxsPage> => {
    try {
      offset = offset || 0
      limit = limit || 10

      const account = await getAccount({ haskoinUrl: await this.getHaskoinURL(), address })
      const txs = await getTransactions({
        haskoinUrl: await this.getHaskoinURL(),
        address,
        params: { offset, limit },
      })

      if (!account || !txs) {
        throw new Error('Invalid address')
      }

      return {
        total: account.txs,
        txs: txs.map(utils.parseTransaction),
      }
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the transaction details of a given transaction id.
   *
   * @param {string} txId The transaction id.
   * @returns {Tx} The transaction details of the given transaction id.
   *
   * @throws {"Invalid TxID"} Thrown if the given transaction id is an invalid one.
   */
  getTransactionData = async (txId: string): Promise<Tx> => {
    try {
      const tx = await getTransaction({ haskoinUrl: await this.getHaskoinURL(), txId })

      if (!tx) {
        throw new Error('Invalid TxID')
      }

      return utils.parseTransaction(tx)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the rates and fees.
   *
   * @param {string} memo The memo to be used for fee calculation (optional)
   * @returns {FeesWithRates} The fees and rates
   */
  getFeesWithRates = async (memo?: string): Promise<FeesWithRates> => {
    const nextBlockFeeRate = await getSuggestedFee()
    const rates: FeeRates = {
      fastest: nextBlockFeeRate * 5,
      fast: nextBlockFeeRate * 1,
      average: nextBlockFeeRate * 0.5,
    }

    const fees: Fees = {
      type: 'byte',
      fast: utils.calcFee(rates.fast, memo),
      average: utils.calcFee(rates.average, memo),
      fastest: utils.calcFee(rates.fastest, memo),
    }

    return { fees, rates }
  }

  /**
   * Get the current fees.
   *
   * @returns {Fees} The fees without memo
   */
  getFees = async (): Promise<Fees> => {
    try {
      const { fees } = await this.getFeesWithRates()
      return fees
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the fees for transactions with memo.
   * If you want to get `Fees` and `FeeRates` at once, use `getFeesAndRates` method
   *
   * @param {string} memo
   * @returns {Fees} The fees with memo
   */
  getFeesWithMemo = async (memo: string): Promise<Fees> => {
    try {
      const { fees } = await this.getFeesWithRates(memo)
      return fees
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Get the fee rates for transactions without a memo.
   * If you want to get `Fees` and `FeeRates` at once, use `getFeesAndRates` method
   *
   * @returns {FeeRates} The fee rate
   */
  getFeeRates = async (): Promise<FeeRates> => {
    try {
      const { rates } = await this.getFeesWithRates()
      return rates
    } catch (error) {
      return Promise.reject(error)
    }
  }

  /**
   * Transfer BCH.
   *
   * @param {TxParams&FeeRate} params The transfer options.
   * @returns {TxHash} The transaction hash.
   */
  transfer = async (params: TxParams & { feeRate?: FeeRate }): Promise<TxHash> => {
    try {
      const index = params.walletIndex || 0
      const derivationPath = this.rootDerivationPaths[this.network] + `${index}`

      const feeRate = params.feeRate || (await this.getFeeRates()).fast
      const { builder, utxos } = await utils.buildTx({
        ...params,
        feeRate,
        sender: await this.getAddress(),
        haskoinUrl: await this.getHaskoinURL(),
        network: this.network,
      })

      const keyPair = this.getBCHKeys(this.phrase, derivationPath)

      utxos.forEach((utxo, index) => {
        builder.sign(index, keyPair, undefined, 0x41, utxo.witnessUtxo.value)
      })

      const tx = builder.build()
      const txHex = tx.toHex()

      return await broadcastTx({
        network: this.network,
        txHex,
        nodeUrl: await this.getNodeURL(),
        auth: this.nodeAuth,
      })
    } catch (e) {
      return Promise.reject(e)
    }
  }
}

export { Client }
