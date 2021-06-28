import { ethers, BigNumber } from 'ethers'
import { BaseAmount } from '@xchainjs/xchain-util'
import { FeeOption, Fees } from '@xchainjs/xchain-client'

export type Address = string

export enum EthNetwork {
  Test = 'ropsten',
  Main = 'homestead',
}

export type TxOverrides = {
  // mandatory: https://github.com/ethers-io/ethers.js/issues/469#issuecomment-475926538
  gasLimit: ethers.BigNumberish
  gasPrice?: ethers.BigNumberish
}

export type InfuraCreds = {
  projectId: string
  projectSecret?: string
}

export type GasPrices = Record<FeeOption, BaseAmount>

export type FeesWithGasPricesAndLimits = { fees: Fees; gasPrices: GasPrices; gasLimit: BigNumber }

export type ApproveParams = {
  walletIndex?: number
  spender: Address
  sender: Address
  amount?: BaseAmount
}
