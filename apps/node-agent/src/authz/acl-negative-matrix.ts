export type AclNegativeCase = {
  routeFamily: string;
  methods: readonly string[];
  requiredCapability: 'library-read' | 'path-read' | 'asset-write' | 'album-write' | 'album-delete' | 'upload-operation' | 'administrator' | 'peer-grant';
  unauthenticatedStatuses: readonly number[];
  crossLibraryMustNotReveal: boolean;
};

export const aclNegativeMatrix: readonly AclNegativeCase[] = [
  { routeFamily: '/v1/libraries', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/external-scan-review', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/metadata-export', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/assets/{assetId}/thumbnail', methods: ['GET'], requiredCapability: 'path-read', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/assets/{assetId}/original', methods: ['GET'], requiredCapability: 'path-read', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/assets/{assetId}/versions', methods: ['GET', 'POST'], requiredCapability: 'asset-write', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/assets/{assetId}/versions/{versionId}', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/recycle-bin', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/recycle-bin/restore', methods: ['POST'], requiredCapability: 'asset-write', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/assets', methods: ['GET'], requiredCapability: 'library-read', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/assets/{assetId}/tags/{tag}', methods: ['PUT', 'DELETE'], requiredCapability: 'asset-write', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/albums', methods: ['GET', 'POST'], requiredCapability: 'album-write', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/libraries/{libraryId}/albums/{albumId}/members', methods: ['GET', 'PUT', 'DELETE'], requiredCapability: 'album-write', unauthenticatedStatuses: [401, 403, 404], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/uploads', methods: ['POST'], requiredCapability: 'upload-operation', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/pairing', methods: ['GET', 'POST', 'PUT', 'DELETE'], requiredCapability: 'administrator', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/resources', methods: ['GET'], requiredCapability: 'administrator', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
  { routeFamily: '/v1/diagnostics', methods: ['GET'], requiredCapability: 'administrator', unauthenticatedStatuses: [401, 403], crossLibraryMustNotReveal: true },
];
