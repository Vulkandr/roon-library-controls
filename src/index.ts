// Copyright (c) 2026 Vulkandr. MIT License (see LICENSE).

export {
  RoonLibraryClient,
  NotInLibraryError,
  NothingPlayingError,
  readState,
} from './client';
export type { LibraryClientOptions, LibraryClientEvents, TrackInfo, AlbumInfo, AddMode } from './client';
export { UnsupportedCoreError, brokerIdFromCoreId, DEFAULT_PORT } from './connection';
export { CallError } from './remoting';
