from PIL import Image, ImageDraw, ImageFilter
import math

def create_icon():
    size = (1024, 1024)
    radius = 200
    
    # 1. 创建背景渐变
    # 深蓝色 #1A2A6C 到 亮蓝色 #2D5AF0
    base = Image.new('RGBA', size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(base)
    
    # 渐变背景
    for i in range(size[1]):
        r = int(26 + (45 - 26) * (i / size[1]))
        g = int(42 + (90 - 42) * (i / size[1]))
        b = int(108 + (240 - 108) * (i / size[1]))
        draw.line([(0, i), (size[0], i)], fill=(r, g, b, 255))
    
    # 应用圆角遮罩
    mask = Image.new('L', size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
    
    icon = Image.new('RGBA', size, (0, 0, 0, 0))
    icon.paste(base, (0, 0), mask)
    
    draw = ImageDraw.Draw(icon)
    
    # 2. 绘制 PDF 文档背景
    # 白色文档，居中
    doc_margin = 200
    doc_rect = [doc_margin, doc_margin, size[0] - doc_margin, size[1] - doc_margin]
    doc_color = (255, 255, 255, 255)
    
    # 文档阴影
    shadow_offset = 20
    shadow_img = Image.new('RGBA', size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow_img)
    shadow_draw.rounded_rectangle([doc_rect[0]+shadow_offset, doc_rect[1]+shadow_offset, doc_rect[2]+shadow_offset, doc_rect[3]+shadow_offset], radius=40, fill=(0, 0, 0, 100))
    shadow_img = shadow_img.filter(ImageFilter.GaussianBlur(15))
    icon = Image.alpha_composite(icon, shadow_img)
    
    draw = ImageDraw.Draw(icon)
    draw.rounded_rectangle(doc_rect, radius=40, fill=doc_color)
    
    # 3. 绘制折角效果 (右上方)
    fold_size = 120
    draw.polygon([
        (size[0] - doc_margin - fold_size, doc_margin),
        (size[0] - doc_margin, doc_margin + fold_size),
        (size[0] - doc_margin - fold_size, doc_margin + fold_size)
    ], fill=(220, 220, 220, 255))
    
    # 4. 绘制核心数学符号 Σ
    sigma_color = (26, 42, 108, 255)
    s_x, s_y = 512, 512
    s_size = 200
    # 手绘 Σ
    sigma_points = [
        (s_x - s_size, s_y - s_size),
        (s_x + s_size, s_y - s_size),
        (s_x + s_size, s_y - s_size + 40),
        (s_x - s_size + 120, s_y),
        (s_x + s_size, s_y + s_size - 40),
        (s_x + s_size, s_y + s_size),
        (s_x - s_size, s_y + s_size),
        (s_x - s_size, s_y + s_size - 40),
        (s_x + s_size - 180, s_y),
        (s_x - s_size, s_y - s_size + 40)
    ]
    draw.polygon(sigma_points, fill=sigma_color)
    
    # 5. 绘制右下角翻译图标 (橙红色圆圈)
    trans_radius = 120
    trans_center = (size[0] - 220, size[1] - 220)
    draw.ellipse([trans_center[0]-trans_radius, trans_center[1]-trans_radius, trans_center[0]+trans_radius, trans_center[1]+trans_radius], fill=(255, 87, 34, 255))
    
    # 绘制简单的翻译转换箭头
    arrow_color = (255, 255, 255, 255)
    # 上箭头
    draw.line([trans_center[0]-50, trans_center[1]-20, trans_center[0]+50, trans_center[1]-20], fill=arrow_color, width=15)
    draw.polygon([(trans_center[0]+50, trans_center[1]-40), (trans_center[0]+80, trans_center[1]-20), (trans_center[0]+50, trans_center[1])], fill=arrow_color)
    # 下箭头
    draw.line([trans_center[0]-50, trans_center[1]+20, trans_center[0]+50, trans_center[1]+20], fill=arrow_color, width=15)
    draw.polygon([(trans_center[0]-50, trans_center[1]), (trans_center[0]-80, trans_center[1]+20), (trans_center[0]-50, trans_center[1]+40)], fill=arrow_color)

    # 保存
    icon.save('src-tauri/icons/icon.png')
    print("Icon generated successfully at src-tauri/icons/icon.png")

if __name__ == '__main__':
    create_icon()
