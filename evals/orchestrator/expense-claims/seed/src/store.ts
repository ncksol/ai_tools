import type { Expense } from "./expenses.ts";

export class Store {
  expenses = new Map<string, Expense>();
  #seq = 0;

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq}`;
  }
}
