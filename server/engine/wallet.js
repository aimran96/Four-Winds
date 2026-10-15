import { GameError } from '../errors.js';

// Balance is kept in integer cents so money never accumulates float error.
export class Wallet {
  constructor(cents) {
    this.cents = cents;
  }

  debit(cents) {
    if (!Number.isInteger(cents) || cents <= 0) throw new GameError('bad_amount');
    if (cents > this.cents) throw new GameError('insufficient_funds');
    this.cents -= cents;
  }

  credit(cents) {
    if (!Number.isInteger(cents) || cents < 0) throw new GameError('bad_amount');
    this.cents += cents;
  }
}
