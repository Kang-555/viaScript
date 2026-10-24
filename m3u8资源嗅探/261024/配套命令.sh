~ $ cat c
#!/data/data/com.termux/files/usr/bin/bash
DOWNLOAD_DIR="$HOME/storage/downloads"

while true; do
    FILES=("$DOWNLOAD_DIR"/batch*.txt)
    if [[ ! -e "${FILES[0]}" ]]; then
        echo "✅任务队列为空，退出"
        break
    fi
    FILE="${FILES[0]}"

    echo -e "\n=====处理 $FILE ====="

    ALL_CMDS=()
    DIR_NAME=""
    FIRST_LINE=1
    while IFS= read -r CMD; do
        if [[ $FIRST_LINE -eq 1 ]]; then
            if [[ -z "$CMD" || "$CMD" =~ ^# ]]; then
                continue
            fi
            DIR_NAME="$CMD"
            FIRST_LINE=0
            continue
        fi
        [[ -z "$CMD" || "$CMD" =~ ^# ]] && continue
        ALL_CMDS+=("$CMD")
    done < "$FILE"

    if [[ ${#ALL_CMDS[@]} -eq 0 ]]; then
        echo "⚠️文件内无有效命令，跳过"
        rm -f "$FILE"
        continue
    fi
    if [[ -z "$DIR_NAME" ]]; then
        echo "⚠️第一条命令无法解析名称，跳过该文 件"
        rm -f "$FILE"
        continue
    fi

    SAFE_NAME=$(echo "$DIR_NAME" | sed 's/[\/:*?"<>|]/_/g')
    SUB_DIR="$DOWNLOAD_DIR/$SAFE_NAME"
    mkdir -p "$SUB_DIR"
    echo "📂公共父目录：$SUB_DIR"

    for CMD in "${ALL_CMDS[@]}"; do
        MOD_CMD="${CMD//~\/storage\/downloads/$SUB_DIR}"
        echo "执行：$MOD_CMD"
        eval "$MOD_CMD"
    done

    rm -f "$FILE"
    echo "🗑️已删除 $FILE"
done
~ $