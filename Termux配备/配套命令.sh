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
    OUTPUT=$(bash "$FILE" 2>&1)
    EXIT_CODE=$?

    if [[ $EXIT_CODE -eq 0 ]]; then
        IDX=$((IDX + 1))
        LOG="$SUCCESS_DIR/success.log"
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')]"
            echo "序号: $IDX"
            echo "文件名: $(basename "$FILE")"
            echo "完成情况: 成功 (退出码=0)"
            echo "------------------------"
        } >> "$LOG"
        echo "✅执行成功"
    else
        LOG="$FAIL_DIR/fail_$(basename "$FILE").log"
        {
            echo "[$(date '+%Y-%m-%d %H:%M:%S')]"
            echo "文件名: $(basename "$FILE")"
            echo "退出码: $EXIT_CODE"
            echo "报错消息:"
            echo "$OUTPUT"
        } > "$LOG"
        echo "❌执行失败，退出码: $EXIT_CODE，详情见 $LOG"
    fi

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