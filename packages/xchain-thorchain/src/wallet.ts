import { Address, Network, Wallet as BaseWallet, WalletFactory, WalletParams } from '@xchainjs/xchain-client'
import { CosmosSDKClient } from '@xchainjs/xchain-cosmos'
import { validatePhrase } from '@xchainjs/xchain-crypto'

import { PrivKey } from 'cosmos-client'

export interface Wallet extends BaseWallet {
  getPrivateKey(index: number): Promise<PrivKey>
}

class DefaultWallet implements Wallet {
  protected readonly params: WalletParams
  protected readonly phrase: string
  protected readonly cosmosClient: CosmosSDKClient

  protected constructor(params: WalletParams, phrase: string) {
    this.params = params
    this.phrase = phrase
    this.cosmosClient = new CosmosSDKClient({
      server: '',
      chainId: '',
      prefix: this.params.network === Network.Mainnet ? 'thor' : 'tthor',
    })
  }

  static create(phrase: string): WalletFactory<DefaultWallet> {
    return async (params: WalletParams) => {
      if (!validatePhrase(phrase)) throw new Error('Invalid phrase')
      return new this(params, phrase)
    }
  }

  async getAddress(index: number): Promise<Address> {
    return this.cosmosClient.getAddressFromMnemonic(this.phrase, this.params.getFullDerivationPath(index))
  }

  async getPrivateKey(index: number): Promise<PrivKey> {
    return this.cosmosClient.getPrivKeyFromMnemonic(this.phrase, this.params.getFullDerivationPath(index))
  }
}

export const Wallet = DefaultWallet
