import 'package:flutter_test/flutter_test.dart';
import 'package:photomesh_mobile/main.dart';

void main() {
  testWidgets('shows the PhotoMesh scaffold', (tester) async {
    await tester.pumpWidget(const PhotoMeshApp());
    expect(find.textContaining('PhotoMesh'), findsOneWidget);
  });
}
