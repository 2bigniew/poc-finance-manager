export interface AccessTokenClaims {
  sub: string;
  type: 'access';
  // Without a per-token id, two tokens signed for the same user within the same
  // second (same iat/exp/sub/type) would be byte-identical - jti keeps every issued
  // refresh token's hash unique so rapid-succession issuance never collides.
  jti: string;
  iat: number;
  exp: number;
}

export interface RefreshTokenClaims {
  sub: string;
  type: 'refresh';
  jti: string;
  iat: number;
  exp: number;
}
