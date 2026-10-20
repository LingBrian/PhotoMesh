import 'package:flutter/material.dart';
import 'l10n/app_strings.dart';

void main() => runApp(const PhotoMeshApp());

class PhotoMeshApp extends StatelessWidget {
  const PhotoMeshApp({super.key});

  @override
  Widget build(BuildContext context) => MaterialApp(
        title: 'PhotoMesh',
        theme: ThemeData(colorSchemeSeed: const Color(0xFF28734E)),
        supportedLocales: const [Locale('zh', 'CN'), Locale('en')],
        home: Builder(builder: (context) {
          final languageCode = Localizations.localeOf(context).languageCode;
          return Scaffold(body: Center(child: Text(appStrings[languageCode] ?? appStrings['en']!)));
        }),
      );
}
