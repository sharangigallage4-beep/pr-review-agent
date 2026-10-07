async function fetchOrder(db, id) {
  return db.orders.findById(id);
}

async function getOrderTotal(db, id) {
  const order = fetchOrder(db, id);
  return order.items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function applyDiscount(expression, total) {
  return eval(expression.replace('TOTAL', total));
}

module.exports = { fetchOrder, getOrderTotal, applyDiscount };
