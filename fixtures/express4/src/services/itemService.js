// fixtures/express4/src/services/itemService.js
"use strict";

const items = [
  { id: 1, name: "Widget A", price: 9.99 },
  { id: 2, name: "Widget B", price: 19.99 },
  { id: 3, name: "Widget C", price: 29.99 },
];

function getAll() {
  return items;
}

function getById(id) {
  return items.find((item) => item.id === Number(id)) || null;
}

function create(data) {
  const item = { id: items.length + 1, ...data };
  items.push(item);
  return item;
}

function remove(id) {
  const idx = items.findIndex((item) => item.id === Number(id));
  if (idx === -1) return false;
  items.splice(idx, 1);
  return true;
}

module.exports = { getAll, getById, create, remove };
