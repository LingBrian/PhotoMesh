import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'upload_job.dart';

class NodeSettings implements NodeSettingsStore {
  NodeSettings({FlutterSecureStorage? secureStorage})
      : _secure = secureStorage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _secure;
  static const _nodeKey = 'bound_node_v1';
  static const _tokenKey = 'bound_node_token_v1';
  static const _policyKey = 'network_policy_v1';
  static const _deviceIdKey = 'device_id_v1';

  Future<String> deviceId() async {
    final prefs = await SharedPreferences.getInstance();
    final existing = prefs.getString(_deviceIdKey);
    if (existing != null && existing.isNotEmpty) return existing;
    final random = Random.secure();
    final generated = List<int>.generate(16, (_) => random.nextInt(256))
        .map((value) => value.toRadixString(16).padLeft(2, '0')).join();
    await prefs.setString(_deviceIdKey, generated);
    return generated;
  }

  @override
  Future<BoundNode?> loadNode() async {
    final encoded = (await SharedPreferences.getInstance()).getString(_nodeKey);
    if (encoded == null) return null;
    final value = jsonDecode(encoded) as Map<String, dynamic>;
    return BoundNode(baseUrl: value['baseUrl'] as String, libraryId: value['libraryId'] as String, nodeId: value['nodeId'] as String);
  }

  @override
  Future<String?> loadToken() => _secure.read(key: _tokenKey);

  Future<void> bind(BoundNode node, String token) async {
    final uri = Uri.tryParse(node.baseUrl);
    if (uri == null || !uri.hasAuthority || !['http', 'https'].contains(uri.scheme) || uri.userInfo.isNotEmpty ||
        uri.hasQuery || uri.hasFragment || node.libraryId.trim().isEmpty || node.nodeId.trim().isEmpty) {
      throw const FormatException('目标主节点地址、图库 ID 或设备 ID 无效');
    }
    final isLocalDevelopmentAddress = uri.host == 'localhost' || uri.host == '127.0.0.1' || uri.host == '::1' || uri.host == '10.0.2.2';
    if (uri.scheme != 'https' && !(kDebugMode && isLocalDevelopmentAddress)) {
      throw const FormatException('生产连接必须使用 HTTPS；明文 HTTP 仅允许调试构建连接本机或 Android 模拟器宿主。');
    }
    await (await SharedPreferences.getInstance()).setString(_nodeKey, jsonEncode({
      'baseUrl': uri.toString().replaceFirst(RegExp(r'/$'), ''),
      'libraryId': node.libraryId.trim(),
      'nodeId': node.nodeId.trim(),
    }));
    if (token.isEmpty) {
      await _secure.delete(key: _tokenKey);
    } else {
      await _secure.write(key: _tokenKey, value: token);
    }
  }

  Future<NetworkPolicy> loadPolicy() async {
    final raw = (await SharedPreferences.getInstance()).getString(_policyKey);
    for (final policy in NetworkPolicy.values) {
      if (policy.name == raw) return policy;
    }
    return NetworkPolicy.wifiOnly;
  }

  Future<void> savePolicy(NetworkPolicy policy) async {
    await (await SharedPreferences.getInstance()).setString(_policyKey, policy.name);
  }
}

abstract interface class NodeSettingsStore {
  Future<BoundNode?> loadNode();
  Future<String?> loadToken();
}
