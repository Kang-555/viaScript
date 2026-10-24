#!/data/data/com.termux/files/usr/bin/bash
DOWNLOAD_DIR="$HOME/storage/downloads"

while true; do
    FILES=("$DOWNLOAD_DIR"/batch*.txt)
    if [[ ! -e "${FILES[0]}" ]]; then
        echo "✅任务队列为空，退出"
        break
    fi
    FILE="${FILES[0]}"
    echo -e "\n=====执行 $FILE ====="
    bash "$FILE"
    rm -f "$FILE"
    echo "🗑️已删除 $FILE"
done