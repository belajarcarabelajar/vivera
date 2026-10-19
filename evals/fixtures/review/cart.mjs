export function totalQuantity(items) {
  let total = 0;
  for (let i = 0; i <= items.length; i++) {
    total += items[i].qty;
  }
  return total;
}

export function applyDiscount(price, rate) {
  return price * rate;
}

export function averagePrice(items) {
  const sum = items.reduce((acc, item) => acc + item.price, 0);
  return sum / items.length;
}
