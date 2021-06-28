import * as bip32 from 'bip32'
import { BncClient } from '@binance-chain/javascript-sdk'
import * as crypto from '@binance-chain/javascript-sdk/lib/crypto'
import { Address, Network, Wallet as BaseWallet, WalletFactory, WalletParams } from '@xchainjs/xchain-client'
import { validatePhrase, getSeed } from '@xchainjs/xchain-crypto'

type SigningDelegate = BncClient['_signingDelegate']

export interface Wallet extends BaseWallet {
  getSigningDelegate(index: number): Promise<SigningDelegate>
}

class DefaultWallet implements Wallet {
  private readonly params: WalletParams
  private readonly phrase: string

  protected constructor(params: WalletParams, phrase: string) {
    this.params = params
    this.phrase = phrase
  }

  static create(phrase: string): WalletFactory<DefaultWallet> {
    return async (params: WalletParams) => {
      if (!validatePhrase(phrase)) throw new Error('Invalid phrase')
      return new this(params, phrase)
    }
  }

  protected async getPrivateKey(index: number): Promise<string> {
    const seed = getSeed(this.phrase)
    const path = this.params.getFullDerivationPath(index)
    const node = bip32.fromSeed(seed).derivePath(path)
    if (node.privateKey === undefined) throw new Error('child does not have a privateKey')
    return node.privateKey.toString('hex')
  }

  async getAddress(index: number): Promise<Address> {
    const privateKey = await this.getPrivateKey(index)
    const prefix = this.params.network === Network.Testnet ? 'tbnb' : 'bnb'
    return crypto.getAddressFromPrivateKey(privateKey, prefix)
  }

  async getSigningDelegate(index: number): Promise<SigningDelegate> {
    const privateKey = await this.getPrivateKey(index)
    return async (tx, signMsg?) => {
      return tx.sign(privateKey, signMsg)
    }
  }
}

export const Wallet = DefaultWallet
