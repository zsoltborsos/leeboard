---
name: cart-module
description: Where the cart state lives
metadata:
  type: project
---

Cart state lives in `src/cart/store.ts` (a zustand store); `useCart()` is the only reader. Line items are keyed by SKU.
