export function add(a, b) {
  return a + b;
}

export function divide(a, b) {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}

export function fib(n) {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
}
