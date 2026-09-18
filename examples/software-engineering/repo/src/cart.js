'use strict';

/**
 * A tiny shopping cart.
 *
 * The bug this example is built around: `total()` sums unit prices and ignores
 * how many of each item the cart holds, so a line of four items is billed once.
 */
class Cart {
  constructor() {
    this.items = [];
  }

  add(item) {
    this.items.push(item);
    return this;
  }

  total() {
    return this.items.reduce((sum, item) => sum + item.price, 0);
  }
}

module.exports = { Cart };
