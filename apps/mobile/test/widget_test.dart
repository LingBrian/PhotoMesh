import 'package:flutter/widgets.dart' show Scrollable;
import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/main.dart';

void main() {
  testWidgets('shows the PhotoMesh scaffold', (tester) async {
    await tester.pumpWidget(const PhotoMeshApp(testMode: true));
    expect(find.textContaining('PhotoMesh'), findsOneWidget);
    final backgroundNotice = find.textContaining('Android schedules background work');
    await tester.scrollUntilVisible(backgroundNotice, 300, scrollable: find.byType(Scrollable).first);
    expect(backgroundNotice, findsOneWidget);
    expect(find.textContaining('not real-time guarantees'), findsOneWidget);
  });
}
