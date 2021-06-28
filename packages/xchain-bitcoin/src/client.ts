import * as Utils from './utils'
import * as sochain from './sochain-api'
import {
  TxHistoryParams,
  TxsPage,
  Address,
  Tx,
  Balance,
  Fees,
  UTXOClient,
  TxType,
  FeeOption,
  FeeRates,
  FeeType,
  FeesWithRates,
  Network,
  ClientParams as BaseClientParams,
  Client as BaseClient,
  ClientFactory,
  TxParams,
  TxHash,
  FeeRate,
} from '@xchainjs/xchain-client'
import { AssetBTC, assetAmount, assetToBase } from '@xchainjs/xchain-util'

import { BTC_DECIMAL } from './const'
import {} from './types/client-types'
import { Wallet } from './wallet'

export interface ClientParams extends BaseClientParams {
  sochainUrl: string
  blockstreamUrl: string
}

export const MAINNET_PARAMS: ClientParams = {
  network: Network.Mainnet,
  getFullDerivationPath: (index: number) => `84'/0'/0'/0/${index}`,
  explorer: {
    url: 'https://blockstream.info',
    getAddressUrl(address: string) {
      return `${this.url}/address/${address}`
    },
    getTxUrl(txid: string) {
      return `${this.url}/tx/${txid}`
    },
  },
  sochainUrl: 'https://sochain.com/api/v2',
  blockstreamUrl: 'https://blockstream.info',
}

export const TESTNET_PARAMS: ClientParams = {
  ...MAINNET_PARAMS,
  network: Network.Testnet,
  getFullDerivationPath: (index: number) => `84'/1'/0'/0/${index}`,
  explorer: {
    ...MAINNET_PARAMS.explorer,
    url: 'https://blockstream.info/testnet',
  },
}

export class Client extends BaseClient<ClientParams, Wallet> implements UTXOClient {
  static readonly create: ClientFactory<Client> = Client.bindFactory((x: ClientParams) => new Client(x))

  async validateAddress(address: string): Promise<boolean> {
    return Utils.validateAddress(address, Utils.btcNetwork(this.params.network))
  }

  async getBalance(address: Address): Promise<Balance[]> {
    return Utils.getBalance({
      sochainUrl: this.params.sochainUrl,
      network: this.params.network,
      address: address,
    })
  }

  async getTransactions(params: TxHistoryParams): Promise<TxsPage> {
    // Sochain API doesn't have pagination parameter
    const offset = params?.offset ?? 0
    const limit = params?.limit || 10

    const response = await sochain.getAddress({
      address: params?.address + '',
      sochainUrl: this.params.sochainUrl,
      network: this.params.network,
    })
    const total = response.txs.length
    const transactions: Tx[] = []

    const txs = response.txs.filter((_, index) => offset <= index && index < offset + limit)
    for (const txItem of txs) {
      const rawTx = await sochain.getTx({
        sochainUrl: this.params.sochainUrl,
        network: this.params.network,
        hash: txItem.txid,
      })
      const tx: Tx = {
        asset: AssetBTC,
        from: rawTx.inputs.map((i) => ({
          from: i.address,
          amount: assetToBase(assetAmount(i.value, BTC_DECIMAL)),
        })),
        to: rawTx.outputs
          .filter((i) => i.type !== 'nulldata')
          .map((i) => ({ to: i.address, amount: assetToBase(assetAmount(i.value, BTC_DECIMAL)) })),
        date: new Date(rawTx.time * 1000),
        type: TxType.Transfer,
        hash: rawTx.txid,
      }
      transactions.push(tx)
    }

    const result: TxsPage = {
      total,
      txs: transactions,
    }
    return result
  }

  async getTransactionData(txId: string): Promise<Tx> {
    const rawTx = await sochain.getTx({
      sochainUrl: this.params.sochainUrl,
      network: this.params.network,
      hash: txId,
    })
    return {
      asset: AssetBTC,
      from: rawTx.inputs.map((i) => ({
        from: i.address,
        amount: assetToBase(assetAmount(i.value, BTC_DECIMAL)),
      })),
      to: rawTx.outputs.map((i) => ({ to: i.address, amount: assetToBase(assetAmount(i.value, BTC_DECIMAL)) })),
      date: new Date(rawTx.time * 1000),
      type: TxType.Transfer,
      hash: rawTx.txid,
    }
  }

  async getFeesWithRates(memo?: string): Promise<FeesWithRates> {
    const txFee = await sochain.getSuggestedTxFee()
    const rates: FeeRates = {
      fastest: txFee * 5,
      fast: txFee * 1,
      average: txFee * 0.5,
    }

    const fees: Fees = {
      type: FeeType.PerByte,
      fast: Utils.calcFee(rates.fast, memo),
      average: Utils.calcFee(rates.average, memo),
      fastest: Utils.calcFee(rates.fastest, memo),
    }

    return { fees, rates }
  }

  async getFees(): Promise<Fees> {
    const { fees } = await this.getFeesWithRates()
    return fees
  }

  async getFeesWithMemo(memo: string): Promise<Fees> {
    const { fees } = await this.getFeesWithRates(memo)
    return fees
  }

  async getFeeRates(): Promise<FeeRates> {
    const { rates } = await this.getFeesWithRates()
    return rates
  }

  async transfer(params: TxParams & { feeRate?: FeeRate }): Promise<TxHash> {
    if (this.wallet === null) throw new Error('client must be unlocked')
    const index = params.walletIndex ?? 0
    if (!(Number.isSafeInteger(index) && index >= 0)) throw new Error('index must be a non-negative integer')

    // set the default fee rate to `fast`
    const feeRate = params.feeRate ?? (await this.getFeeRates())[FeeOption.Fast]

    /**
     * do not spend pending UTXOs when adding a memo
     * https://github.com/xchainjs/xchainjs-lib/issues/330
     */
    const spendPendingUTXO: boolean = params.memo ? false : true

    const { psbt } = await Utils.buildTx({
      ...params,
      feeRate,
      sender: await this.getAddress(index),
      sochainUrl: this.params.sochainUrl,
      network: this.params.network,
      spendPendingUTXO,
    })

    const btcKeys = await this.wallet.getBtcKeys(index)
    psbt.signAllInputs(btcKeys) // Sign all inputs
    psbt.finalizeAllInputs() // Finalise inputs
    const txHex = psbt.extractTransaction().toHex() // TX extracted and formatted to hex

    return await Utils.broadcastTx({
      network: this.params.network,
      txHex,
      blockstreamUrl: this.params.blockstreamUrl,
    })
  }
}
