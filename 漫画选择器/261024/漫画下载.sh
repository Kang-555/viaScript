cat > b <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DOWNLOAD_DIR="/sdcard/Download"

while true; do
    shopt -s nullglob
    FILES=("$DOWNLOAD_DIR"/*.txt)
    shopt -u nullglob
    if [[ ${#FILES[@]} -eq 0 ]]; then
        echo "✅无待处理txt，退出"
        break
    fi
    for FILE in "${FILES[@]}"; do
        HAS_CMD=$(grep -cve '^\s*$' -e '^\s*#' "$FILE" 2>/dev/null)
        if [[ "$HAS_CMD" -eq 0 ]]; then
            echo "⏭️ $FILE 无有效命令，跳过"
            continue
        fi
        echo -e "\n=====执行 $FILE ====="
        bash "$FILE"
        rm -f "$FILE"
        echo "🗑️已删除 $FILE"
    done
done
EOF
chmod +x b