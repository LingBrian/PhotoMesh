import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/l10n/app_strings.dart';

void main() {
  test(
      'provides permission recovery and source availability copy in Chinese and English',
      () {
    expect(appString('zh', 'permissionRevoked'), isNot('permissionRevoked'));
    expect(appString('en', 'permissionRevoked'), isNot('permissionRevoked'));
    expect(appString('zh', 'sourceUnavailable'), isNot('sourceUnavailable'));
    expect(appString('en', 'sourceUnavailable'), isNot('sourceUnavailable'));
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
