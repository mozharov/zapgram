export class ExposedError extends Error {
  public translationKey: string
  public translationParams?: Record<string, string | number>

  constructor(args: ConstructorArgs) {
    super()
    this.name = ExposedError.name
    this.message = args.message ?? 'Exposed error'
    this.translationKey = args.translationKey
    this.translationParams = args.translationParams
  }
}

interface ConstructorArgs {
  message?: string
  translationKey: string
  translationParams?: TranslationParams
}

export type TranslationParams = Record<string, string | number>
