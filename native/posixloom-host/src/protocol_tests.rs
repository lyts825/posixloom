use super::*;

// hello 帧编码后应能无损读回，协议版本与类型字段保持不变。
#[test]
fn protocol_frame_round_trips() {
    let mut encoded = Vec::new();
    let mut event = Event::new("hello");
    event.max_frame_bytes = Some(MAX_FRAME_BYTES);
    write_frame(&mut encoded, &event).unwrap();
    let decoded: serde_json::Value = read_frame(&mut encoded.as_slice()).unwrap();
    assert_eq!(decoded["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(decoded["type"], "hello");
}

// 请求校验：零超时、含 '=' 的环境键、大小写重复的环境键都必须被拒绝。
#[test]
fn exec_request_rejects_zero_timeout_and_invalid_environment() {
    let mut request = ExecRequest {
        protocol_version: PROTOCOL_VERSION,
        kind: "exec".to_string(),
        program: "node".to_string(),
        args: Vec::new(),
        cwd: ".".to_string(),
        env: BTreeMap::new(),
        timeout_ms: 0,
        shell_namespace: None,
        input_base64: None,
        tty: false,
        columns: None,
        rows: None,
    };
    assert!(validate_exec_request(&request).is_err());
    request.timeout_ms = 1;
    request
        .env
        .insert("BAD=KEY".to_string(), "value".to_string());
    assert!(validate_exec_request(&request).is_err());
    request.env.clear();
    request.env.insert("Path".to_string(), "first".to_string());
    request.env.insert("PATH".to_string(), "second".to_string());
    assert!(validate_exec_request(&request).is_err());

    request.env.clear();
    request.tty = true;
    assert!(validate_exec_request(&request).is_err());
    request.columns = Some(80);
    request.rows = Some(24);
    assert!(validate_exec_request(&request).is_ok());
    request.rows = Some(32768);
    assert!(validate_exec_request(&request).is_err());
    request.rows = Some(24);
    for key in ["", "abc", &"A".repeat(64), &"g".repeat(64), &"0".repeat(65)] {
        request.shell_namespace = Some(key.to_string());
        assert!(validate_exec_request(&request).is_err());
    }
    request.shell_namespace = Some("0123456789abcdef".repeat(4));
    assert!(validate_exec_request(&request).is_ok());
}

#[test]
fn fragmented_reads_preserve_unicode_frames() {
    struct Fragmented<'a> {
        remaining: &'a [u8],
        maximum: usize,
    }
    impl Read for Fragmented<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let count = buffer.len().min(self.maximum).min(self.remaining.len());
            buffer[..count].copy_from_slice(&self.remaining[..count]);
            self.remaining = &self.remaining[count..];
            Ok(count)
        }
    }
    let expected =
        serde_json::json!({"argv":["", "a b", "中文😀", "\"\\\n"], "nested":[null, true, 42]});
    let mut bytes = Vec::new();
    write_frame(&mut bytes, &expected).unwrap();
    for maximum in 1..32 {
        let mut reader = Fragmented {
            remaining: &bytes,
            maximum,
        };
        let actual: serde_json::Value = read_frame(&mut reader).unwrap();
        assert_eq!(actual, expected);
        assert!(reader.remaining.is_empty());
    }
}

#[test]
fn invalid_and_incomplete_frames_fail_closed() {
    let mut frame = Vec::new();
    write_frame(&mut frame, &serde_json::json!({"text":"中文"})).unwrap();
    for length in 0..frame.len() {
        assert!(read_frame::<_, serde_json::Value>(&mut &frame[..length]).is_err());
    }
    for bytes in [
        vec![0, 0, 0, 0],
        u32::MAX.to_le_bytes().to_vec(),
        vec![4, 0, 0, 0, 34, 0xc0, 0xaf, 34],
    ] {
        assert!(read_frame::<_, serde_json::Value>(&mut bytes.as_slice()).is_err());
    }
}

#[test]
fn frame_writer_reports_sink_errors() {
    struct Broken;
    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("broken sink"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    assert!(write_frame(&mut Broken, &serde_json::json!({"hello":true})).is_err());
}

#[test]
fn input_base64_is_canonical() {
    assert_eq!(decode_input(None).unwrap(), Vec::<u8>::new());
    assert_eq!(
        decode_input(Some("AP8=".to_string())).unwrap(),
        vec![0, 255]
    );
    for invalid in ["Zg", "Zh==", "Zg==\n", "____", "%20"] {
        assert!(decode_input(Some(invalid.to_string())).is_err());
    }
}
