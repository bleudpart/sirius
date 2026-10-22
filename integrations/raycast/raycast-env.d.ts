/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** URL API SIRIUS - HTTPS terminé par /api, ou boucle locale HTTP */
  "apiUrl": string,
  /** Session SIRIUS - access_token personnel ; renouveler après expiration. Jamais le mot de passe. */
  "accessToken": string,
  /** Clé Cerebras personnelle (facultatif) - Uniquement envoyée à votre API SIRIUS pour les demandes IA autorisées. */
  "cerebrasKey"?: string
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `ask` command */
  export type Ask = ExtensionPreferences & {}
  /** Preferences accessible in the `meetings` command */
  export type Meetings = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `ask` command */
  export type Ask = {}
  /** Arguments passed to the `meetings` command */
  export type Meetings = {}
}

