import { BigNumber, SwapParams, SwapProvider, Transaction } from '@liquality/types'
import { Provider } from '@liquality/provider'
import { PendingTxError } from '@liquality/errors'
import { sha256 } from '@liquality/crypto'
import { addressToString } from '@liquality/utils'

import _filter from 'lodash/filter'

export default class SolanaSwapFindProvider extends Provider implements Partial<SwapProvider> {
  private instructions = {
    init: 0,
    claim: 1,
    refund: 2
  }

  async findInitiateSwapTransaction(swapParams: SwapParams): Promise<Transaction> {
    const { refundAddress } = swapParams

    return await this._findTransactionByAddress({
      address: addressToString(refundAddress),
      swapParams,
      instruction: this.instructions.init,
      validation: this._compareParams
    })
  }

  async findClaimSwapTransaction(swapParams: SwapParams, initiationTxHash: string): Promise<Transaction> {
    const [initTransaction] = await this.getMethod('getParsedAndConfirmedTransactions')([initiationTxHash])

    if (!initTransaction) {
      throw new PendingTxError(`Transaction receipt is not available: ${initiationTxHash}`)
    }

    const {
      _raw: { buyer }
    } = initTransaction

    return await this._findTransactionByAddress({
      swapParams,
      address: buyer,
      instruction: this.instructions.claim,
      validation: this._validateSecret
    })
  }

  async findRefundSwapTransaction(swapParams: SwapParams, initiationTxHash: string): Promise<Transaction> {
    const [initTransaction] = await this.getMethod('getParsedAndConfirmedTransactions')([initiationTxHash])

    if (!initTransaction) {
      throw new PendingTxError(`Transaction receipt is not available: ${initiationTxHash}`)
    }

    const {
      _raw: { seller }
    } = initTransaction

    return await this._findTransactionByAddress({
      swapParams,
      address: seller,
      instruction: this.instructions.refund
    })
  }

  async findFundSwapTransaction(): Promise<null> {
    return null
  }

  _compareParams(
    swapParams: SwapParams,
    initTxParams: { buyer: string; seller: string; secret_hash: string; value: BigNumber; expiration: BigNumber }
  ): boolean {
    return (
      swapParams.recipientAddress === initTxParams.buyer &&
      swapParams.refundAddress === initTxParams.seller &&
      swapParams.secretHash === initTxParams.secret_hash &&
      swapParams.value.eq(initTxParams.value) &&
      new BigNumber(swapParams.expiration).eq(initTxParams.expiration)
    )
  }

  _validateSecret(swapParams: SwapParams, data: { secret: string }): boolean {
    return swapParams.secretHash === sha256(data.secret)
  }

  _batchSignatures(addressHistory: object[]): string[][] {
    const batches: string[][] = [[]]

    let currentBatch = 0

    const MAX_NUMBER_OF_REQUESTS = 100

    addressHistory.forEach((pastTx: { signature: string }, idx: number) => {
      if (idx && idx % MAX_NUMBER_OF_REQUESTS === 0) {
        currentBatch++
        batches.push([])
      }

      batches[currentBatch].push(pastTx.signature)
    })

    return batches
  }

  async _findTransactionByAddress({
    address,
    swapParams,
    instruction,
    validation
  }: {
    address: string
    swapParams: SwapParams
    instruction: number
    validation?: Function
  }): Promise<Transaction> {
    const addressHistory = await this.getMethod('getAddressHistory')(address)

    const batch = this._batchSignatures(addressHistory)

    const parsedTransactions = batch.map((sp) => this.getMethod('getParsedAndConfirmedTransactions')(sp))

    const matrix = await Promise.all(parsedTransactions)

    let initTransaction

    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix[i].length; j++) {
        const data = matrix[i][j]

        if (data._raw?.instruction === instruction) {
          if (instruction === this.instructions.refund) {
            initTransaction = data
            break
          } else if (validation(swapParams, data._raw)) {
            initTransaction = data
            initTransaction.secret = data.secret
            break
          }
        }
      }

      if (initTransaction) {
        break
      }
    }

    return initTransaction
  }
}