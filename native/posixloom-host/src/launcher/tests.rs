use super::*;

// 生成带进程 ID 与纳秒时间戳的唯一临时目录路径，避免测试并行互相干扰。
fn temp_root(label: &str) -> std::path::PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    std::env::temp_dir().join(format!("posixloom-{label}-{}-{nonce}", std::process::id()))
}

/// 写入启动器完整性检查所需的最小应用树、Runtime 与对应 SHA256SUMS。
fn write_hashed_application(root: &std::path::Path, runtime_id: &str, mode: &str) {
    let package = root.join("package.json");
    let defaults = root.join("config").join("defaults.json");
    let script = root.join("dist").join("src").join("cli").join("main.js");
    let current = root.join("runtime").join("current");
    let manifest = root
        .join("runtime")
        .join("versions")
        .join(runtime_id)
        .join("manifest.json");
    std::fs::create_dir_all(defaults.parent().unwrap()).unwrap();
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::create_dir_all(manifest.parent().unwrap()).unwrap();
    std::fs::write(&package, br#"{"type":"module"}"#).unwrap();
    std::fs::write(&defaults, b"{}").unwrap();
    std::fs::write(&script, b"// fixture").unwrap();
    std::fs::write(&current, runtime_id).unwrap();
    std::fs::write(
        &manifest,
        format!(r#"{{"manifestVersion":1,"runtimeId":"{runtime_id}","mode":"{mode}"}}"#),
    )
    .unwrap();
    std::fs::write(
        root.join("SHA256SUMS"),
        format!(
            "{}  config/defaults.json\n{}  dist/src/cli/main.js\n{}  package.json\n{}  runtime/current\n{}  runtime/versions/{runtime_id}/manifest.json\n",
            sha256_file(&defaults).unwrap(),
            sha256_file(&script).unwrap(),
            sha256_file(&package).unwrap(),
            sha256_file(&current).unwrap(),
            sha256_file(&manifest).unwrap(),
        ),
    )
    .unwrap();
}

// 运行时 ID 校验必须拒绝路径遍历（../）、分隔符（/）与空串。
#[test]
fn runtime_id_rejects_traversal() {
    assert!(valid_runtime_id("runtime-1.2.3"));
    assert!(!valid_runtime_id("../outside"));
    assert!(!valid_runtime_id("runtime/other"));
    assert!(!valid_runtime_id(""));
}

// 存在 release 运行时而指针缺失时，正常路径必须失败（不允许 PATH 回退）。
#[test]
fn release_runtime_without_pointer_is_fail_closed() {
    let root = temp_root("launcher-no-pointer");
    let runtime = root
        .join("runtime")
        .join("versions")
        .join("runtime-release");
    std::fs::create_dir_all(&runtime).unwrap();
    std::fs::write(
        runtime.join("manifest.json"),
        r#"{"runtimeId":"runtime-release","mode":"release"}"#,
    )
    .unwrap();
    assert!(release_runtime_present(&root).unwrap());
    assert!(select_launcher_node(root.to_str().unwrap()).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

// data 侧指针内容非法时正常路径失败，但恢复模式应能改用捆绑运行时的 node。
#[test]
fn recovery_uses_bundled_node_when_data_pointer_is_invalid() {
    let root = temp_root("launcher-recovery-pointer");
    let data_pointer = root.join("data").join("runtime").join("current");
    let bundled_pointer = root.join("runtime").join("current");
    let runtime = root.join("runtime").join("versions").join("runtime-dev");
    let node = runtime
        .join("node")
        .join(if cfg!(windows) { "node.exe" } else { "node" });
    std::fs::create_dir_all(data_pointer.parent().unwrap()).unwrap();
    std::fs::create_dir_all(node.parent().unwrap()).unwrap();
    std::fs::write(data_pointer, "../invalid").unwrap();
    std::fs::write(bundled_pointer, "runtime-dev").unwrap();
    std::fs::write(
        runtime.join("manifest.json"),
        r#"{"manifestVersion":1,"runtimeId":"runtime-dev","mode":"development"}"#,
    )
    .unwrap();
    std::fs::write(&node, b"recovery-node").unwrap();

    assert!(select_launcher_node(root.to_str().unwrap()).is_err());
    assert_eq!(
        select_recovery_launcher_node(&root).unwrap(),
        node.to_string_lossy()
    );
    std::fs::remove_dir_all(root).unwrap();
}

// 带 SHA256SUMS 的 development 包仍应在缺少捆绑 Node 时使用开发机 Node；
// 这是开发包允许第三方组件回退的契约，也是打包 CI 的实际布局。
#[test]
fn recovery_allows_external_node_for_hashed_development_package() {
    let root = temp_root("launcher-development-node-fallback");
    write_hashed_application(&root, "runtime-dev", "development");

    let selected = select_recovery_launcher_node(&root).unwrap();
    assert!(selected == "node" || std::path::Path::new(&selected).is_file());
    std::fs::remove_dir_all(root).unwrap();
}

// 同样缺少 Node 时，release 包不得借开发回退绕过捆绑组件要求。
#[test]
fn recovery_rejects_external_node_for_hashed_release_package() {
    let root = temp_root("launcher-release-node-fallback");
    write_hashed_application(&root, "runtime-release", "release");

    assert!(select_recovery_launcher_node(&root).is_err());
    std::fs::remove_dir_all(root).unwrap();
}

// release 的 node 组件哈希匹配才放行；文件被篡改后必须报 SHA-256 mismatch。
#[test]
fn release_node_is_hashed_before_launch() {
    let root = temp_root("launcher-node-hash");
    let runtime_root = root.join("runtime-release");
    let entrypoint = if cfg!(windows) {
        "node/node.exe"
    } else {
        "node/node"
    };
    let node_path = runtime_root.join(entrypoint);
    std::fs::create_dir_all(node_path.parent().unwrap()).unwrap();
    std::fs::write(&node_path, b"trusted-node").unwrap();
    let manifest = LauncherManifest {
        manifest_version: Some(1),
        runtime_id: "runtime-release".to_string(),
        mode: Some("release".to_string()),
        components: vec![LauncherComponent {
            id: "node".to_string(),
            entrypoint: entrypoint.to_string(),
            sha256: Some(sha256_file(&node_path).unwrap()),
        }],
    };
    let runtime = SelectedRuntime {
        id: "runtime-release".to_string(),
        root: runtime_root,
        release: true,
        bundled: true,
    };
    assert_eq!(release_node(&runtime, &manifest).unwrap(), node_path);
    std::fs::write(&node_path, b"tampered-node").unwrap();
    assert!(release_node(&runtime, &manifest)
        .unwrap_err()
        .contains("SHA-256 mismatch"));
    std::fs::remove_dir_all(root).unwrap();
}

// release 位置的运行时不得用 development 模式清单伪装降级。
#[test]
fn installed_runtime_cannot_downgrade_to_development_mode() {
    let runtime = SelectedRuntime {
        id: "runtime-release".to_string(),
        root: std::path::PathBuf::from("runtime-release"),
        release: true,
        bundled: false,
    };
    let manifest = LauncherManifest {
        manifest_version: Some(1),
        runtime_id: "runtime-release".to_string(),
        mode: Some("development".to_string()),
        components: Vec::new(),
    };
    assert!(verify_launcher_mode(&runtime, &manifest).is_err());
}

// 清单精确覆盖 + 入口脚本哈希：清单未覆盖的新增文件、
// 以及被篡改的 main.js 都必须使校验失败。
#[test]
fn package_entrypoint_checksum_is_enforced() {
    let root = temp_root("launcher-controller-hash");
    let script = root.join("dist").join("src").join("cli").join("main.js");
    let defaults = root.join("config").join("defaults.json");
    let package = root.join("package.json");
    std::fs::create_dir_all(script.parent().unwrap()).unwrap();
    std::fs::create_dir_all(defaults.parent().unwrap()).unwrap();
    std::fs::write(&script, b"trusted-controller").unwrap();
    std::fs::write(&defaults, b"{}").unwrap();
    std::fs::write(&package, br#"{"type":"module"}"#).unwrap();
    std::fs::write(
        root.join("SHA256SUMS"),
        format!(
            "{}  config/defaults.json\n{}  dist/src/cli/main.js\n{}  package.json\n",
            sha256_file(&defaults).unwrap(),
            sha256_file(&script).unwrap(),
            sha256_file(&package).unwrap(),
        ),
    )
    .unwrap();
    verify_package_checksum(&root, "dist/src/cli/main.js").unwrap();
    verify_package_application(&root).unwrap();
    let uncovered = root.join("dist").join("uncovered.js");
    std::fs::write(&uncovered, b"uncovered").unwrap();
    assert!(verify_package_application(&root)
        .unwrap_err()
        .contains("does not exactly cover"));
    std::fs::remove_file(uncovered).unwrap();
    std::fs::write(&script, b"tampered-controller").unwrap();
    assert!(verify_package_checksum(&root, "dist/src/cli/main.js")
        .unwrap_err()
        .contains("SHA-256 mismatch"));
    std::fs::remove_dir_all(root).unwrap();
}
