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
    while IFS= read -r CMD; do
        [[ -z "$CMD" || "$CMD" =~ ^# ]] && continue
        ALL_CMDS+=("$CMD")
        if [[ -z "$DIR_NAME" ]]; then
            if [[ $CMD =~ --save-name[[:space:]]+\"([^\"]+)\" ]]; then
                DIR_NAME="${BASH_REMATCH[1]}"
            elif [[ $CMD =~ -o[[:space:]]+~\/storage\/downloads\/([^\"]+) ]]; then
                DIR_NAME="${BASH_REMATCH[1]}"
                DIR_NAME="${DIR_NAME%.*}"
            fi

            # 优先提取《》里面的内容
            if [[ $DIR_NAME =~ 《([^》]+)》 ]]; then
                DIR_NAME="${BASH_REMATCH[1]}"
            else
                # 没有书名号，再切掉末尾 -数字
                DIR_NAME="${DIR_NAME%-*[0-9]}"
            fi
        fi
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