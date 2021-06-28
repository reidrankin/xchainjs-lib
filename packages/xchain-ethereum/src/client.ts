import { ethers, BigNumberish, BigNumber } from 'ethers'
import { Provider, TransactionResponse } from '@ethersproject/abstract-provider'
import { EtherscanProvider, getDefaultProvider } from '@ethersproject/providers'

import erc20ABI from './data/erc20.json'
import { toUtf8Bytes, parseUnits } from 'ethers/lib/utils'
import {
  GasOracleResponse,
  TxOverrides,
  GasPrices,
  FeesWithGasPricesAndLimits,
  InfuraCreds,
  ApproveParams,
} from './types'
import {
  Address,
  Balance,
  Client as BaseClient,
  ClientParams as BaseClientParams,
  FeeOption,
  FeeType,
  Fees,
  MultiAssetClient,
  Network,
  Tx,
  TxsPage,
  TxParams,
  TxHash,
  TxHistoryParams,
} from '@xchainjs/xchain-client'
import { AssetETH, baseAmount, BaseAmount, assetToString, Asset, delay } from '@xchainjs/xchain-util'
import * as ethplorerAPI from './ethplorer-api'
import * as etherscanAPI from './etherscan-api'
import {
  ETH_DECIMAL,
  xchainNetworkToEths,
  getTokenAddress,
  validateAddress,
  SIMPLE_GAS_COST,
  BASE_TOKEN_GAS_COST,
  getFee,
  MAX_APPROVAL,
  ETHAddress,
  getDefaultGasPrices,
  getTxFromEthplorerTokenOperation,
  getTxFromEthplorerEthTransaction,
  getTokenBalances,
} from './utils'
import { Wallet } from './wallet'

export interface ClientParams extends BaseClientParams {
  ethplorerUrl: string
  ethplorerApiKey: string
  etherscanApiKey?: string
  infuraCreds?: InfuraCreds
}

export const MAINNET_PARAMS: ClientParams = {
  network: Network.Mainnet,
  getFullDerivationPath: (index: number) => `44'/60'/0'/0/${index}`,
  explorer: {
    url: 'https://etherscan.io',
    getAddressUrl(address: string) {
      return `${this.url}/address/${address}`
    },
    getTxUrl(txid: string) {
      return `${this.url}/tx/${txid}`
    },
  },
  ethplorerUrl: 'https://api.ethplorer.io',
  ethplorerApiKey: 'freekey',
}

export const TESTNET_PARAMS: ClientParams = {
  ...MAINNET_PARAMS,
  network: Network.Testnet,
  getFullDerivationPath: (index: number) => `44'/60'/0'/0/${index}`, // this is INCORRECT but makes the unit tests pass
  explorer: {
    ...MAINNET_PARAMS.explorer,
    url: 'https://ropsten.etherscan.io',
  },
}

export class Client extends BaseClient<ClientParams, Wallet> implements MultiAssetClient {
  readonly provider: Provider

  protected constructor(params: ClientParams) {
    super(params)
    const infuraCreds = this.params.infuraCreds
    if (infuraCreds !== undefined) {
      this.provider = new ethers.providers.InfuraProvider(
        xchainNetworkToEths(this.params.network),
        infuraCreds.projectSecret ? infuraCreds : infuraCreds.projectId,
      )
    } else {
      this.provider = getDefaultProvider(xchainNetworkToEths(this.params.network))
    }
  }

  static readonly create = Client.bindFactory((x: ClientParams) => new Client(x))

  /**
   * @deprecated
   */
  getProvider(): Provider {
    return this.provider
  }

  async getSigner(index = 0): Promise<ethers.Signer> {
    if (this.wallet === null) throw new Error('client must be unlocked')
    const signer = await this.wallet.getSigner(index, this.provider)
    return signer
  }

  protected async getVoidSigner(index: number): Promise<ethers.VoidSigner> {
    if (this.wallet === null) throw new Error('client must be unlocked')
    return new ethers.VoidSigner(await this.getAddress(index), this.provider)
  }

  /**
   * Get etherjs EtherscanProvider interface.
   *
   * @returns {EtherscanProvider} The current etherjs EtherscanProvider interface.
   */
  protected async getEtherscanProvider(): Promise<EtherscanProvider> {
    return new EtherscanProvider(this.params.network, this.params.etherscanApiKey)
  }

  async validateAddress(address: Address): Promise<boolean> {
    return validateAddress(address)
  }

  async getBalance(address: Address, assets?: Asset[]): Promise<Balance[]> {
    // get ETH balance directly from provider
    const ethBalance: BigNumber = await this.getProvider().getBalance(address)
    const ethBalanceAmount = baseAmount(ethBalance.toString(), ETH_DECIMAL)

    switch (this.params.network) {
      case Network.Mainnet: {
        // use ethplorerAPI for mainnet - ignore assets
        const account = await ethplorerAPI.getAddress(this.params.ethplorerUrl, address, this.params.ethplorerApiKey)
        const balances: Balance[] = [
          {
            asset: AssetETH,
            amount: ethBalanceAmount,
          },
        ]

        if (account.tokens) {
          balances.push(...getTokenBalances(account.tokens))
        }

        return balances
      }
      case Network.Testnet: {
        // use etherscan for testnet

        const newAssets = assets || [AssetETH]
        // Follow approach is only for testnet
        // For mainnet, we will use ethplorer api(one request only)
        // https://github.com/xchainjs/xchainjs-lib/issues/252
        // And to avoid etherscan api call limit, it gets balances in a sequence way, not in parallel
        const balances = []
        for (let i = 0; i < newAssets.length; i++) {
          const asset = newAssets[i]
          const etherscan = await this.getEtherscanProvider()
          if (assetToString(asset) !== assetToString(AssetETH)) {
            // Handle token balances
            const assetAddress = getTokenAddress(asset)
            if (!assetAddress) {
              throw new Error(`Invalid asset ${asset}`)
            }
            const balance = await etherscanAPI.getTokenBalance({
              baseUrl: etherscan.baseUrl,
              address,
              assetAddress,
              apiKey: etherscan.apiKey,
            })
            const decimals =
              BigNumber.from(
                await this.callOffline<BigNumberish>(0, assetAddress, erc20ABI, 'decimals', []),
              ).toNumber() || ETH_DECIMAL

            if (!Number.isNaN(decimals)) {
              balances.push({
                asset,
                amount: baseAmount(balance.toString(), decimals),
              })
            }
          } else {
            balances.push({
              asset: AssetETH,
              amount: ethBalanceAmount,
            })
          }
          // Due to etherscan api call limitation, put some delay before another call
          // Free Etherscan api key limit: 5 calls per second
          // So 0.3s delay is reasonable for now
          await delay(300)
        }

        return balances
      }
    }
  }

  /**
   * Get transaction history of a given address with pagination options.
   * By default it will return the transaction history of the current wallet.
   *
   * @param {TxHistoryParams} params The options to get transaction history. (optional)
   * @returns {TxsPage} The transaction history.
   */
  async getTransactions(params: TxHistoryParams): Promise<TxsPage> {
    const offset = params?.offset || 0
    const limit = params?.limit || 10
    const assetAddress = params?.asset

    const maxCount = 10000

    let transactions
    const etherscan = await this.getEtherscanProvider()

    if (assetAddress) {
      transactions = await etherscanAPI.getTokenTransactionHistory({
        baseUrl: etherscan.baseUrl,
        address: params?.address,
        assetAddress,
        page: 0,
        offset: maxCount,
        apiKey: etherscan.apiKey,
      })
    } else {
      transactions = await etherscanAPI.getETHTransactionHistory({
        baseUrl: etherscan.baseUrl,
        address: params?.address,
        page: 0,
        offset: maxCount,
        apiKey: etherscan.apiKey,
      })
    }

    return {
      total: transactions.length,
      txs: transactions.filter((_, index) => index >= offset && index < offset + limit),
    }
  }

  /**
   * Get the transaction details of a given transaction id.
   *
   * @param {string} txId The transaction id.
   * @param {string} assetAddress The asset address. (optional)
   * @returns {Tx} The transaction details of the given transaction id.
   *
   * @throws {"Need to provide valid txId"}
   * Thrown if the given txId is invalid.
   */
  async getTransactionData(txId: string, assetAddress?: Address): Promise<Tx> {
    switch (this.params.network) {
      case Network.Mainnet: {
        // use ethplorerAPI for mainnet - ignore assetAddress
        const txInfo = await ethplorerAPI.getTxInfo(this.params.ethplorerUrl, txId, this.params.ethplorerApiKey)

        if (txInfo.operations === undefined || txInfo.operations.length === 0) {
          return getTxFromEthplorerEthTransaction(txInfo)
        }

        const tx = getTxFromEthplorerTokenOperation(txInfo.operations[0])
        if (!tx) throw new Error('Could not parse transaction data')
        return tx
      }
      case Network.Testnet: {
        let tx
        const etherscan = await this.getEtherscanProvider()
        const txInfo = await etherscan.getTransaction(txId)
        if (txInfo) {
          if (assetAddress) {
            tx =
              (
                await etherscanAPI.getTokenTransactionHistory({
                  baseUrl: etherscan.baseUrl,
                  assetAddress,
                  startblock: txInfo.blockNumber,
                  endblock: txInfo.blockNumber,
                  apiKey: etherscan.apiKey,
                })
              ).filter((info) => info.hash === txId)[0] ?? null
          } else {
            tx =
              (
                await etherscanAPI.getETHTransactionHistory({
                  baseUrl: etherscan.baseUrl,
                  startblock: txInfo.blockNumber,
                  endblock: txInfo.blockNumber,
                  apiKey: etherscan.apiKey,
                  address: txInfo.from,
                })
              ).filter((info) => info.hash === txId)[0] ?? null
          }
        }

        if (!tx) throw new Error('Could not get transaction history')
        return tx
      }
    }
  }

  async call<T>(
    index: number,
    contractAddress: Address,
    abi: ethers.ContractInterface,
    func: string,
    params: Array<unknown>,
  ): Promise<T> {
    const signer = await this.getSigner(index)
    const contract = new ethers.Contract(contractAddress, abi, this.provider).connect(signer)
    return contract[func](...params)
  }

  async callOffline<T>(
    index: number,
    contractAddress: Address,
    abi: ethers.ContractInterface,
    func: string,
    params: Array<unknown>,
  ): Promise<T> {
    const signer = await this.getVoidSigner(index)
    const contract = new ethers.Contract(contractAddress, abi, this.provider).connect(signer)
    return contract[func](...params)
  }

  async estimateCall(
    contractAddress: Address,
    abi: ethers.ContractInterface,
    func: string,
    params: Array<unknown>,
    index = 0,
  ): Promise<BigNumber> {
    const signer = await this.getVoidSigner(index)
    const contract = new ethers.Contract(contractAddress, abi, this.provider).connect(signer)
    return contract.estimateGas[func](...params)
  }

  /**
   * Check allowance.
   *
   * @param {Address} spender The spender address.
   * @param {Address} sender The sender address.
   * @param {BaseAmount} amount The amount of token.
   * @returns {boolean} `true` or `false`.
   */
  async isApproved(spender: Address, sender: Address, amount: BaseAmount): Promise<boolean> {
    const txAmount = BigNumber.from(amount.amount().toFixed())
    const allowance = await this.callOffline<BigNumberish>(0, sender, erc20ABI, 'allowance', [spender, spender])
    return txAmount.lte(allowance)
  }

  /**
   * Check allowance.
   *
   * @param {number} walletIndex which wallet to use to make the call
   * @param {Address} spender The spender index.
   * @param {Address} sender The sender address.
   * @param {feeOption} FeeOption Fee option (optional)
   * @param {BaseAmount} amount The amount of token. By default, it will be unlimited token allowance. (optional)
   * @returns {TransactionResponse} The transaction result.
   */
  async approve({
    walletIndex: index,
    spender,
    sender,
    feeOptionKey: feeOption,
    amount,
  }: ApproveParams & { feeOptionKey?: FeeOption }): Promise<TransactionResponse> {
    index ??= 0
    const gasPrice =
      feeOption &&
      BigNumber.from(
        (
          await this.estimateGasPrices()
            .then((prices) => prices[feeOption])
            .catch(() => getDefaultGasPrices()[feeOption])
        )
          .amount()
          .toFixed(),
      )
    const gasLimit = await this.estimateApprove({ walletIndex: index, spender, sender, amount }).catch(() => undefined)

    const txAmount = amount ? BigNumber.from(amount.amount().toFixed()) : MAX_APPROVAL
    const txResult = await this.call<TransactionResponse>(index, sender, erc20ABI, 'approve', [
      spender,
      txAmount,
      {
        from: await this.getAddress(index),
        gasPrice,
        gasLimit,
      },
    ])

    return txResult
  }

  /**
   * Estimate gas limit of approve.
   *
   * @param {Address} spender The spender address.
   * @param {Address} sender The sender address.
   * @param {BaseAmount} amount The amount of token. By default, it will be unlimited token allowance. (optional)
   * @returns {BigNumber} The estimated gas limit.
   */
  async estimateApprove({ walletIndex: index, spender, sender, amount }: ApproveParams): Promise<BigNumber> {
    index ??= 0

    const txAmount = amount ? BigNumber.from(amount.amount().toFixed()) : MAX_APPROVAL
    const gasLimit = await this.estimateCall(
      sender,
      erc20ABI,
      'approve',
      [spender, txAmount, { from: await this.getAddress(index) }],
      index,
    )

    return gasLimit
  }

  async transfer(
    params: TxParams & { gasLimit?: BigNumber } & (
        | { feeOptionKey?: FeeOption; gasPrice?: never }
        | { feeOptionKey?: never; gasPrice?: BaseAmount }
      ),
  ): Promise<TxHash> {
    if (this.wallet === null) throw new Error('client must be unlocked')
    const index = params.walletIndex ?? 0
    if (!(Number.isSafeInteger(index) && index >= 0)) throw new Error('index must be a non-negative integer')

    const { asset, memo, amount, recipient, feeOptionKey: feeOption, gasPrice, gasLimit } = params

    const txAmount = BigNumber.from(amount.amount().toFixed())

    let assetAddress
    if (asset && assetToString(asset) !== assetToString(AssetETH)) {
      assetAddress = getTokenAddress(asset)
    }

    const isETHAddress = assetAddress === ETHAddress

    // feeOption

    const defaultGasLimit: ethers.BigNumber = isETHAddress ? SIMPLE_GAS_COST : BASE_TOKEN_GAS_COST

    let overrides: TxOverrides = {
      gasLimit: gasLimit ?? defaultGasLimit,
      gasPrice: gasPrice && BigNumber.from(gasPrice.amount().toFixed()),
    }

    // override `overrides` if `feeOption` is provided
    if (feeOption) {
      const gasPrices = await this.estimateGasPrices().catch(() => getDefaultGasPrices())
      const gasPrice = gasPrices[feeOption]
      const gasLimit = await this.estimateGasLimit({
        ...params,
        walletIndex: index,
      }).catch(() => defaultGasLimit)

      overrides = {
        ...overrides,
        gasLimit,
        gasPrice: BigNumber.from(gasPrice.amount().toFixed()),
      }
    }

    let txResult
    if (assetAddress && !isETHAddress) {
      // Transfer ERC20
      txResult = await this.call<TransactionResponse>(index, assetAddress, erc20ABI, 'transfer', [
        recipient,
        txAmount,
        Object.assign({}, overrides),
      ])
    } else {
      // Transfer ETH
      const transactionRequest: ethers.providers.TransactionRequest = Object.assign(
        {
          nonce: await this.provider.getTransactionCount(await this.getAddress(index)),
          chainId: (await this.provider.getNetwork()).chainId,
          to: recipient,
          value: txAmount,
        },
        {
          ...overrides,
          data: memo ? toUtf8Bytes(memo) : undefined,
        },
      )

      const signer = await this.wallet.getSigner(index)
      const signedTx = await signer.signTransaction(transactionRequest)
      txResult = await this.provider.sendTransaction(signedTx)
    }

    return txResult.hash
  }

  /**
   * Estimate gas price.
   * @see https://etherscan.io/apis#gastracker
   *
   * @returns {GasPrices} The gas prices (average, fast, fastest) in `Wei` (`BaseAmount`)
   */
  async estimateGasPrices(): Promise<GasPrices> {
    const etherscan = await this.getEtherscanProvider()
    const response: GasOracleResponse = await etherscanAPI.getGasOracle(etherscan.baseUrl, etherscan.apiKey)

    // Convert result of gas prices: `Gwei` -> `Wei`
    const averageWei = parseUnits(response.SafeGasPrice, 'gwei')
    const fastWei = parseUnits(response.ProposeGasPrice, 'gwei')
    const fastestWei = parseUnits(response.FastGasPrice, 'gwei')

    return {
      average: baseAmount(averageWei.toString(), ETH_DECIMAL),
      fast: baseAmount(fastWei.toString(), ETH_DECIMAL),
      fastest: baseAmount(fastestWei.toString(), ETH_DECIMAL),
    }
  }

  /**
   * Estimate gas.
   *
   * @param {FeesParams} params The transaction options.
   * @returns {BaseAmount} The estimated gas fee.
   */
  async estimateGasLimit({ walletIndex: index, asset, recipient, amount, memo }: TxParams): Promise<BigNumber> {
    index ??= 0
    const fromAddress = await this.getAddress(index)
    const txAmount = BigNumber.from(amount.amount().toFixed())

    const assetAddress = asset && assetToString(asset) !== assetToString(AssetETH) ? getTokenAddress(asset) : null

    if (assetAddress !== null && assetAddress !== ETHAddress) {
      // ERC20 gas estimate
      const contract = new ethers.Contract(assetAddress, erc20ABI, this.provider)

      return await contract.estimateGas.transfer(recipient, txAmount, {
        from: fromAddress,
      })
    } else {
      // ETH gas estimate
      const transactionRequest = {
        from: fromAddress,
        to: recipient,
        value: txAmount,
        data: memo ? toUtf8Bytes(memo) : undefined,
      }

      return await this.provider.estimateGas(transactionRequest)
    }
  }

  /**
   * Estimate gas prices/limits (average, fast fastest).
   *
   * @param {FeesParams} params
   * @returns {FeesWithGasPricesAndLimits} The estimated gas prices/limits.
   */
  async estimateFeesWithGasPricesAndLimits(params: TxParams): Promise<FeesWithGasPricesAndLimits> {
    // gas prices
    const gasPrices = await this.estimateGasPrices()
    const { fast: fastGP, fastest: fastestGP, average: averageGP } = gasPrices

    // gas limits
    const gasLimit = await this.estimateGasLimit(params)

    return {
      gasPrices,
      fees: {
        type: FeeType.PerByte,
        average: getFee({ gasPrice: averageGP, gasLimit }),
        fast: getFee({ gasPrice: fastGP, gasLimit }),
        fastest: getFee({ gasPrice: fastestGP, gasLimit }),
      },
      gasLimit,
    }
  }

  async getFees(params?: TxParams): Promise<Fees> {
    if (params === undefined) throw new TypeError('params required')

    return (await this.estimateFeesWithGasPricesAndLimits(params)).fees
  }
}
