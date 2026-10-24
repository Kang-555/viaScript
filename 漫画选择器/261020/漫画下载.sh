cat > b <<'EOF'
#!/data/data/com.termux/files/usr/bin/bash
DOWNLOAD_DIR="$HOME/storage/downloads"
PATTERN="ManHuaUrls.txt"
mkdir -p "$DOWNLOAD_DIR"

while true; do
  FILE=$(ls -1tr "$DOWNLOAD_DIR"/$PATTERN 2>/dev/null | head -n1)
  if [ -z "$FILE" ]; then
    echo "✅无任务队列，退出"
    break
  fi
  echo -e "\n=====处理任务文件 $FILE ====="

  # 首行 #漫画名 → 提取做目录名；没有则时间戳兜底
  FIRST_LINE=$(head -n1 "$FILE")
  if [[ "$FIRST_LINE" =~ ^#(.+)$ ]]; then
    TASK_NAME="${BASH_REMATCH[1]}"
    DOWNLOAD_LIST=$(grep -ve '^\s*#' "$FILE")
  else
    TASK_NAME="manga_$(date +%Y%m%d_%H%M%S)"
    DOWNLOAD_LIST=$(cat "$FILE")
  fi
  # 只清理非法字符，不再截取长度
  TASK_NAME=$(echo "$TASK_NAME" | sed 's/[\\/:*?"<>|]/_/g')
  COUNT=$(echo "$DOWNLOAD_LIST" | grep -cve '^\s*$')
  echo "📖漫画名：$TASK_NAME"
  echo "📋读取到 $COUNT 条图片链接"

  MANGA_DIR="$DOWNLOAD_DIR/manga_downloads/$TASK_NAME"
  mkdir -p "$MANGA_DIR"
  echo "📂本次下载目录：$MANGA_DIR"

  cd "$MANGA_DIR"
  if command -v aria2c &>/dev/null; then
    echo "🚀 使用 aria2c 并发下载 (x6)"
    echo "$DOWNLOAD_LIST" | grep -ve '^\s*$' > "$MANGA_DIR/.urls"
    aria2c -i "$MANGA_DIR/.urls" -x 6 -s 6 -k 1M -c \
      --user-agent="Mozilla/5.0" \
      --allow-overwrite=false \
      --save-session="$MANGA_DIR/fail.txt"
    rm -f "$MANGA_DIR/.urls"
    FAILED=$(grep -cve '^\s*$' "$MANGA_DIR/fail.txt" 2>/dev/null)
    if [ "$FAILED" -gt 0 ]; then
      echo "⚠️  有 $FAILED 条下载失败，见 $MANGA_DIR/fail.txt"
    fi
  else
    echo "📥 使用 curl 单条下载"
    echo "$DOWNLOAD_LIST" | grep -ve '^\s*$' | while read -r u; do
      [ -z "$u" ] && continue
      fn=$(basename "$u" | sed 's/?.*//')
      if [ -f "$fn" ]; then
        echo "跳过已存在: $fn"
        continue
      fi
      curl -s -O -C - --retry 3 -A "Mozilla/5.0" "$u" || {
        echo "$u" >> "$MANGA_DIR/fail.txt"
        echo "❌ 下载失败: $u"
      }
    done
  fi

  # JPG图片压缩 quality=80（imagemagick）
  if command -v mogrify &>/dev/null; then
    echo "🖼️开始压缩JPG图片 quality=80"
    find "$MANGA_DIR" -maxdepth 1 -type f \( -iname "*.jpg" -o -iname "*.jpeg" \) | xargs mogrify -quality 80
  else
    echo "ℹ️未找到 mogrify(imagemagick)，跳过图片压缩"
  fi

  # 打包ZIP：直接把文件夹内部文件打包进zip，不带外层目录
  ZIP_FILE="$DOWNLOAD_DIR/manga_downloads/${TASK_NAME}.zip"
  echo "📦打包压缩ZIP：$ZIP_FILE"
  cd "$MANGA_DIR"
  zip -r "$ZIP_FILE" ./*

  # ✅打包成功后直接删除原图文件夹（已启用）
  echo "🗑️打包完成，删除原图文件夹 $MANGA_DIR"
  rm -rf "$MANGA_DIR"

  rm -f "$FILE"
  echo "🗑️已删除任务文件 $FILE"
  echo "✅任务完成！zip文件：$ZIP_FILE"
done
EOF
chmod +x b
