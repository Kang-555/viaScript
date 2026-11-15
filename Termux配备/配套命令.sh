cat > c <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DOWNLOAD_DIR="/sdcard/Download"
SUCCESS_DIR="/sdcard/Download/exec_success"
FAIL_DIR="/sdcard/Download/exec_fail"

mkdir -p "$SUCCESS_DIR" "$FAIL_DIR"

IDX=0

while true; do
    FILE=$(find "$DOWNLOAD_DIR" -maxdepth 1 -name '*.txt' -print -quit)
    if [[ -z "$FILE" ]]; then
        echo "✅无待处理txt，退出"
        break
    fi

    HAS_CMD=$(grep -cve '^\s*$' -e '^\s*#' "$FILE" 2>/dev/null)
    if [[ "$HAS_CMD" -eq 0 ]]; then
        echo "⏭️ $FILE 无有效命令，跳过"
        rm -f "$FILE"
        continue
    fi

    echo -e "\n=====执行 $FILE ====="
    VIDEO_DIR=$(grep -oE -- '--save-dir ("[^"]*"|[^ ]+)' "$FILE" | head -1 | sed -E 's/^--save-dir[[:space:]]+"?//; s/"$//')
    [[ -z "$VIDEO_DIR" ]] && VIDEO_DIR="/sdcard/Download/videos"
    mkdir -p "$VIDEO_DIR"
    TMP_OUTPUT=$(mktemp)
    BEFORE_LIST=$(mktemp)
    AFTER_LIST=$(mktemp)
    ls "$VIDEO_DIR"/*.mp4 "$VIDEO_DIR"/*.mkv "$VIDEO_DIR"/*.ts 2>/dev/null | sort > "$BEFORE_LIST"
    : > "$TMP_OUTPUT"
    EXIT_CODE=0
    FAIL_COUNT=0
    LINE_NO=0
    while IFS= read -r CMD; do
        case "$CMD" in ''|'#'*) continue;; esac
        LINE_NO=$((LINE_NO + 1))
        echo
        echo "▶ [命令$LINE_NO] $CMD"
        eval "$CMD" 2>&1 | tee -a "$TMP_OUTPUT"
        RC=${PIPESTATUS[0]}
        if [[ $RC -ne 0 ]]; then
            EXIT_CODE=$RC
            FAIL_COUNT=$((FAIL_COUNT + 1))
            echo "   ⚠️ [命令$LINE_NO] 退出码 $RC"
        fi
    done < "$FILE"
    ls "$VIDEO_DIR"/*.mp4 "$VIDEO_DIR"/*.mkv "$VIDEO_DIR"/*.ts 2>/dev/null | sort > "$AFTER_LIST"
    NEW_FILES=$(comm -13 "$BEFORE_LIST" "$AFTER_LIST")
    NEW_COUNT=$(grep -c . <<<"$NEW_FILES")
    EXPECTED=$(grep -cE 'N_m3u8DL-RE|curl ' "$FILE" 2>/dev/null)

    if [[ "$NEW_COUNT" -ge "$EXPECTED" && "$EXPECTED" -gt 0 ]]; then
        IDX=$((IDX + 1))
        LAST_MP4=$(printf '%s\n' "$NEW_FILES" | tail -1)
        [[ -z "$LAST_MP4" ]] && LAST_MP4=$(ls "$VIDEO_DIR"/*.mp4 "$VIDEO_DIR"/*.mkv "$VIDEO_DIR"/*.ts 2>/dev/null | tail -1)
        LOG="$SUCCESS_DIR/success.log"
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')]"
            echo "序号: $IDX"
            echo "产出: $NEW_COUNT / $EXPECTED"
            echo "下载文件: $(basename "$LAST_MP4")"
            echo "执行脚本: $(basename "$FILE")"
            echo "完成情况: 成功 (成片数符合预期)"
            echo "------------------------"
        } >> "$LOG"
        echo "✅执行成功，产出 $NEW_COUNT 个视频"
        echo "📥 下载完成！最新文件: $(basename "$LAST_MP4")"
    else
        LOG="$FAIL_DIR/fail_$(basename "$FILE").log"
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')]"
            echo "执行脚本: $(basename "$FILE")"
            echo "失败行数: $FAIL_COUNT | 最近退出码: $EXIT_CODE"
            echo "预期产出: $EXPECTED 个 | 实际产出: $NEW_COUNT 个"
            echo "本次新增文件:"
            echo "$NEW_FILES"
            echo "N_m3u8DL-RE 输出末尾:"
            tail -n 50 "$TMP_OUTPUT"
        } > "$LOG"
        echo "❌执行未完成：预期 $EXPECTED 个，实际 $NEW_COUNT 个，详情见 $LOG"
    fi
    rm -f "$BEFORE_LIST" "$AFTER_LIST"

    rm -f "$TMP_OUTPUT"
    rm -f "$FILE"
    echo "🗑️已删除 $FILE"

    echo -n "继续? [Y=继续 / 10秒自动继续 / 其他键=结束]: "
    read -t 10 RESPONSE
    RESPONSE="${RESPONSE^^}"
    if [[ -n "$RESPONSE" && "$RESPONSE" != "Y" ]]; then
        echo "🛑用户输入 $RESPONSE，脚本结束"
        exit 0
    fi
    [[ -z "$RESPONSE" ]] && echo "⏱️ 10秒无操作，自动继续"
done
echo "🎉 全部处理完毕，共执行 $IDX 个文件"
EOF
chmod +x c