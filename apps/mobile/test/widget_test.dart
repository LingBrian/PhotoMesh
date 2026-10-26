import 'package:flutter/widgets.dart' show Scrollable;
import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/main.dart';

void main() {
  test('returns selected photos in the same order as selection badges', () {
    final assets = [
      (id: 'a', title: 'first'),
      (id: 'b', title: 'second'),
      (id: 'c', title: 'third'),
    ];
    final ordered = orderBySelection(assets, (asset) => asset.id, {'c', 'a'});
    expect(ordered.map((asset) => asset.id), ['c', 'a']);
  });

  test('retains skipped manual selections alongside queue preflight errors', () {
    const summary = '2 added; 1 skipped';
    expect(
      combineManualSelectionStatus(
        queueStatus: 'Network blocked',
        selectionSummary: summary,
      ),
      'Network blocked\n$summary',
    );
    expect(
      combineManualSelectionStatus(
        queueStatus: summary,
        selectionSummary: summary,
      ),
      summary,
    );
    expect(
      combineManualSelectionStatus(
        queueStatus: null,
        selectionSummary: summary,
      ),
      summary,
    );
  });

  testWidgets('shows the PhotoMesh scaffold', (tester) async {
    await tester.pumpWidget(const PhotoMeshApp(testMode: true));
    expect(find.textContaining('PhotoMesh'), findsOneWidget);
    expect(find.byTooltip('Node gallery'), findsOneWidget);
    final backgroundNotice = find.textContaining('Android schedules background work');
    await tester.scrollUntilVisible(backgroundNotice, 300, scrollable: find.byType(Scrollable).first);
    expect(backgroundNotice, findsOneWidget);
    expect(find.textContaining('not real-time guarantees'), findsOneWidget);
  });
}
