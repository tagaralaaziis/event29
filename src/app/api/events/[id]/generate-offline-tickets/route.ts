import { NextRequest, NextResponse } from 'next/server'
import sharp from 'sharp'
import bwipjs from 'bwip-js'
import db from '@/lib/db'
import QRCode from 'qrcode'

function isImageFile(file: File) {
  return file && (file.type === 'image/png' || file.type === 'image/jpeg' || file.name?.endsWith('.png') || file.name?.endsWith('.jpg') || file.name?.endsWith('.jpeg'))
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const formData = await req.formData()
    const templateFile = formData.get('template')
    const barcodeX = Number(formData.get('barcode_x'))
    const barcodeY = Number(formData.get('barcode_y'))
    const barcodeWidth = Number(formData.get('barcode_width'))
    const barcodeHeight = Number(formData.get('barcode_height'))
    const eventId = params.id
    const [rows] = await db.execute('SELECT id, token FROM tickets WHERE event_id = ? ORDER BY id ASC', [eventId])
    const participants = (rows as any[]).map(row => ({ name: row.id, token: row.token }))

    console.log('📝 Processing offline ticket generation request...')
    console.log('Participants count:', participants.length)
    console.log('Barcode position:', { barcodeX, barcodeY, barcodeWidth, barcodeHeight })

    // Type guard for templateFile
    if (typeof templateFile !== 'object' || typeof (templateFile as any).arrayBuffer !== 'function' || typeof (templateFile as any).type !== 'string') {
      return NextResponse.json({ error: 'Invalid template file (not File/Blob)' }, { status: 400 })
    }

    const file = templateFile as File
    console.log('Template file:', file.name, file.type, file.size)

    if (!isImageFile(file)) {
      return NextResponse.json({ error: 'Template file must be PNG or JPG' }, { status: 400 })
    }

    if (participants.length === 0) {
      return NextResponse.json({ error: 'No participants to generate tickets for' }, { status: 400 })
    }

    if (participants.length > 1000) {
      return NextResponse.json({ error: 'Too many tickets, maximum 1000 per batch' }, { status: 400 })
    }

    let templateBuffer = Buffer.from(new Uint8Array(await file.arrayBuffer())) as Buffer

    // Convert JPG to PNG if needed
    if (file.type === 'image/jpeg' || file.name?.endsWith('.jpg') || file.name?.endsWith('.jpeg')) {
      try {
        templateBuffer = await sharp(templateBuffer).png().toBuffer()
        console.log('✅ Converted JPG to PNG')
      } catch (err) {
        return NextResponse.json({ error: 'Failed to convert JPG to PNG', detail: String(err) }, { status: 400 })
      }
    }

    // Get template dimensions
    const templateMeta = await sharp(templateBuffer).metadata()
    const templateWidth = templateMeta.width || 0
    const templateHeight = templateMeta.height || 0
    
    console.log('Template dimensions:', { templateWidth, templateHeight })
    console.log('Original barcode params:', { barcodeX, barcodeY, barcodeWidth, barcodeHeight })

    // Validate barcode position
    if (barcodeX < 0 || barcodeY < 0 || barcodeWidth <= 0 || barcodeHeight <= 0) {
      return NextResponse.json({ error: 'Invalid barcode position or size' }, { status: 400 })
    }

    if (barcodeX + barcodeWidth > templateWidth || barcodeY + barcodeHeight > templateHeight) {
      return NextResponse.json({
        error: `Barcode position exceeds template bounds. Template: ${templateWidth}x${templateHeight}px, Barcode: (${barcodeX},${barcodeY},${barcodeWidth},${barcodeHeight})`,
        templateWidth,
        templateHeight,
        barcodeX,
        barcodeY,
        barcodeWidth,
        barcodeHeight
      }, { status: 400 })
    }

    // Standard ticket size for A4 layout (2 columns x 5 rows)
    const PAGE_W = 2480 // A4 width at 300dpi
    const PAGE_H = 3508 // A4 height at 300dpi
    const TICKET_W = 1200 // Ticket width
    const TICKET_H = 680  // Ticket height
    const COLS = 2
    const ROWS = 5
    const MARGIN_X = 40
    const MARGIN_Y = 40
    const TICKETS_PER_PAGE = COLS * ROWS

    console.log('PDF layout:', { PAGE_W, PAGE_H, TICKET_W, TICKET_H, COLS, ROWS, TICKETS_PER_PAGE })

    // Resize template to fit ticket size while maintaining aspect ratio
    let resizedTemplateBuffer: Buffer
    try {
      resizedTemplateBuffer = await sharp(templateBuffer)
        .resize(TICKET_W, TICKET_H, { 
          fit: 'contain',
          background: { r: 255, g: 255, b: 255, alpha: 1 }
        })
        .png()
        .toBuffer()
      
      console.log('✅ Template resized to ticket dimensions')
    } catch (err) {
      return NextResponse.json({ error: 'Failed to resize template', detail: String(err) }, { status: 500 })
    }

    // Calculate scaling factors
    const scaleX = TICKET_W / templateWidth
    const scaleY = TICKET_H / templateHeight
    const scale = Math.min(scaleX, scaleY) // Use uniform scaling to maintain aspect ratio

    // Calculate scaled barcode position and size
    const scaledBarcodeX = Math.round(barcodeX * scale)
    const scaledBarcodeY = Math.round(barcodeY * scale)
    const scaledBarcodeWidth = Math.max(100, Math.round(barcodeWidth * scale)) // Minimum 100px width
    const scaledBarcodeHeight = Math.max(50, Math.round(barcodeHeight * scale)) // Minimum 50px height

    console.log('Scaled barcode params:', { 
      scale, 
      scaledBarcodeX, 
      scaledBarcodeY, 
      scaledBarcodeWidth, 
      scaledBarcodeHeight 
    })

    // Ensure barcode fits within ticket bounds
    const finalBarcodeX = Math.min(scaledBarcodeX, TICKET_W - scaledBarcodeWidth)
    const finalBarcodeY = Math.min(scaledBarcodeY, TICKET_H - scaledBarcodeHeight)
    const finalBarcodeWidth = Math.min(scaledBarcodeWidth, TICKET_W - finalBarcodeX)
    const finalBarcodeHeight = Math.min(scaledBarcodeHeight, TICKET_H - finalBarcodeY)

    console.log('Final barcode params:', { 
      finalBarcodeX, 
      finalBarcodeY, 
      finalBarcodeWidth, 
      finalBarcodeHeight 
    })

    // Generate ticket images
    const ticketImages: Buffer[] = []
    console.log('🎫 Generating ticket images...')

    for (let i = 0; i < participants.length; i++) {
      const participant = participants[i]
      try {
        // Generate QR code dengan link register token (format benar)
        const registerLink = `http://10.10.11.28:3000/register?token=${participant.token}`
        const qrBufferRaw = await QRCode.toBuffer(registerLink, {
          errorCorrectionLevel: 'H',
          type: 'png',
          width: finalBarcodeWidth,
          margin: 0,
          color: {
            dark: '#000000',
            light: '#FFFFFF',
          },
        })
        const qrBuffer = await sharp(qrBufferRaw)
          .resize(finalBarcodeWidth, finalBarcodeHeight, { fit: 'fill' })
          .png()
          .toBuffer()

        // Composite QR code onto template
        const ticketImg = await sharp(resizedTemplateBuffer)
          .composite([
            { 
              input: qrBuffer, 
              left: finalBarcodeX, 
              top: finalBarcodeY 
            }
          ])
          .png()
          .toBuffer()

        ticketImages.push(ticketImg)

        if ((i + 1) % 10 === 0 || i === participants.length - 1) {
          console.log(`✅ Generated ${i + 1}/${participants.length} ticket images`)
        }
      } catch (err) {
        console.error('QR/template error for token:', participant.token, err)
        return NextResponse.json({ 
          error: 'Failed to generate QR/ticket', 
          detail: String(err), 
          token: participant.token 
        }, { status: 500 })
      }
    }

    console.log('📄 Generating PDF using canvas-based approach...')

    // Use canvas-based PDF generation instead of PDFKit to avoid font issues
    try {
      // Create a simple PDF-like structure using HTML canvas approach
      const { createCanvas } = await import('canvas')
      
      // Calculate pages needed
      const totalPages = Math.ceil(ticketImages.length / TICKETS_PER_PAGE)
      const canvasPages: Buffer[] = []

      for (let page = 0; page < totalPages; page++) {
        const canvas = createCanvas(PAGE_W, PAGE_H)
        const ctx = canvas.getContext('2d')
        
        // Fill white background
        ctx.fillStyle = 'white'
        ctx.fillRect(0, 0, PAGE_W, PAGE_H)

        // Place tickets on this page
        const startIdx = page * TICKETS_PER_PAGE
        const endIdx = Math.min(startIdx + TICKETS_PER_PAGE, ticketImages.length)

        for (let i = startIdx; i < endIdx; i++) {
          const ticketIdx = i - startIdx
          const row = Math.floor(ticketIdx / COLS)
          const col = ticketIdx % COLS
          
          const x = col * (TICKET_W + MARGIN_X) + MARGIN_X
          const y = row * (TICKET_H + MARGIN_Y) + MARGIN_Y

          // Load and draw ticket image
          const img = await import('canvas').then(({ loadImage }) => loadImage(ticketImages[i]))
          ctx.drawImage(img, x, y, TICKET_W, TICKET_H)
        }

        // Convert canvas to PNG buffer
        const pageBuffer = canvas.toBuffer('image/png')
        canvasPages.push(pageBuffer)
      }

      // Convert PNG pages to PDF using a simple approach
      const jsPDF = await import('jspdf').then(m => m.jsPDF)
      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'px',
        format: [PAGE_W, PAGE_H]
      })

      for (let i = 0; i < canvasPages.length; i++) {
        if (i > 0) pdf.addPage()
        
        // Convert buffer to base64
        const base64 = canvasPages[i].toString('base64')
        pdf.addImage(`data:image/png;base64,${base64}`, 'PNG', 0, 0, PAGE_W, PAGE_H)
      }

      const pdfBuffer = Buffer.from(pdf.output('arraybuffer'))
      
      console.log('✅ PDF generated successfully using canvas approach, size:', pdfBuffer.length, 'bytes')

      return new NextResponse(pdfBuffer, {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="offline-tickets-${params.id}.pdf"`,
          'Content-Length': pdfBuffer.length.toString(),
        },
      })

    } catch (canvasError) {
      console.error('Canvas PDF generation failed:', canvasError)
      
      // Fallback: Return images as ZIP file
      console.log('📦 Falling back to ZIP file generation...')
      
      try {
        const JSZip = await import('jszip').then(m => m.default)
        const zip = new JSZip()
        
        // Add each ticket image to ZIP
        for (let i = 0; i < ticketImages.length; i++) {
          const participant = participants[i]
          zip.file(`ticket-${participant.token}.png`, ticketImages[i])
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' })
        
        console.log('✅ ZIP file generated successfully, size:', zipBuffer.length, 'bytes')
        
        return new NextResponse(zipBuffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="offline-tickets-${params.id}.zip"`,
            'Content-Length': zipBuffer.length.toString(),
          },
        })
        
      } catch (zipError) {
        console.error('ZIP generation also failed:', zipError)
        return NextResponse.json({ 
          error: 'Failed to generate both PDF and ZIP', 
          pdfError: String(canvasError),
          zipError: String(zipError)
        }, { status: 500 })
      }
    }

  } catch (err) {
    console.error('Generate offline tickets error:', err, (err instanceof Error ? err.stack : ''))
    return NextResponse.json({ 
      error: 'Failed to generate tickets', 
      detail: String(err),
      stack: err instanceof Error ? err.stack : undefined
    }, { status: 500 })
  }
}