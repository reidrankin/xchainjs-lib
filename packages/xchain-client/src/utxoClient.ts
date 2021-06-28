import { Client, TxParams } from './client'
import { FeeOption, Fees, TxHash } from './types'

export type FeeRate = number
export type FeeRates = Record<FeeOption, FeeRate>
export type FeesWithRates = { rates: FeeRates; fees: Fees }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface UTXOClient extends Client<any, any> {
  getFeesWithRates(memo?: string): Promise<FeesWithRates>
  getFeesWithMemo(memo: string): Promise<Fees>
  getFeeRates(): Promise<FeeRates>

  transfer(params: TxParams & { walletIndex?: number; feeRate?: FeeRate }): Promise<TxHash>
}
