declare global {
  type RawRequest = {
    rawBody: string
  }

  type DiscordAPIResponse<T> = DiscordAPIError | T

  type DiscordAPIError = {
    error: string
  }

  type DiscordTokenResponse = {
    access_token: string
    expires_in: number
    refresh_token: string
    scope: string
    token_type: string
  }

  type DiscordUser = {
    id: string
    username: string
    avatar: string
    discriminator: string
    public_flags: number
    flags: number
    banner: string
    banner_color: string
    accent_color: string
    locale: string
    mfa_enabled: boolean
    premium_type: number
  }
}

export {}
