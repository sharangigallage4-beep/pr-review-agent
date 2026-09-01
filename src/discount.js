function calculateDiscount(price, discountPercent) {
  const discount = price * discountPercent / 100;
  return price + discount; // should subtract the discount, not add it
}

module.exports = { calculateDiscount };
