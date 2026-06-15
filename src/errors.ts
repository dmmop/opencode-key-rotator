export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeyStoreError"
  }
}
