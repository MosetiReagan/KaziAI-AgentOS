'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Cart } = require('../src/cart');

test('an empty cart totals zero', () => {
  assert.equal(new Cart().total(), 0);
});

test('each line is billed for its quantity', () => {
  const cart = new Cart();
  cart.add({ sku: 'espresso', price: 2.5, quantity: 4 });
  cart.add({ sku: 'grinder', price: 10, quantity: 1 });
  assert.equal(cart.total(), 20);
});

test('adding an item returns the cart so calls can be chained', () => {
  const cart = new Cart();
  assert.equal(cart.add({ sku: 'mug', price: 8, quantity: 2 }), cart);
});
