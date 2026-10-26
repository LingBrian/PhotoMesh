import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/l10n/app_strings.dart';

void main() {
  test('provides gallery and preview copy in Chinese and English', () {
    const pickerKeys = [
      'selectedCount', 'noPhotos', 'loadMorePhotos', 'selectPhotosHint', 'photo',
      'selected', 'notSelected', 'selectPhotos', 'cancel', 'add', 'scanFailed', 'retry',
    ];
    const galleryKeys = [
      'remoteGallery',
      'galleryEmpty',
      'galleryLoadMore',
      'galleryUnavailable',
      'galleryRequestFailed',
      'preview',
      'previewLoading',
      'previewTooLarge',
      'previewUnsupported',
      'previewUnavailable',
      'sourceOffline',
      'availabilityOnline',
      'availabilityCached',
      'availabilityOffline',
      'availabilityMissing',
      'close',
    ];
    for (final language in ['zh', 'en']) {
      for (final key in [...galleryKeys, ...pickerKeys]) {
        expect(appStrings[language]!.containsKey(key), isTrue,
            reason: '$language:$key');
      }
    }
    expect(appString('zh', 'preview'), '预览');
    expect(appString('en', 'preview'), 'Preview');
    expect(appString('zh', 'permissionRevoked'), isNot('permissionRevoked'));
    expect(appString('en', 'permissionRevoked'), isNot('permissionRevoked'));
    expect(appString('zh', 'sourceUnavailable'), isNot('sourceUnavailable'));
    expect(appString('en', 'sourceUnavailable'), isNot('sourceUnavailable'));
    expect(appString('zh', 'manualSkipped'), contains('未加入'));
    expect(appString('en', 'manualSkipped'), contains('not added'));
  });

  test('localizes known upload errors and preserves unknown diagnostic codes',
      () {
    expect(localizedUploadError('zh', 'PERMISSION_REVOKED'), contains('已撤销'));
    expect(
        localizedUploadError('en', 'PERMISSION_REVOKED'), contains('revoked'));
    expect(localizedUploadError('zh', 'SOURCE_UNAVAILABLE'), contains('无法访问'));
    expect(localizedUploadError('en', 'SOURCE_CHANGED'),
        appString('en', 'sourceChanged'));
    expect(localizedUploadError('en', 'HTTP_503'), 'HTTP_503');
    expect(localizedUploadError('en', null), isEmpty);
  });
}
