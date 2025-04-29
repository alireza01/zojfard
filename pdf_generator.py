# File: @pdf_generator.py

import json
import sys
from fpdf import FPDF
import io # To capture PDF output in memory

# Define Persian weekdays and time slots
PERSIAN_WEEKDAYS = ["شنبه", "یکشنبه", "دوشنبه", "سه‌شنبه", "چهارشنبه"]
ENGLISH_WEEKDAYS = ["saturday", "sunday", "monday", "tuesday", "wednesday"]
TIME_SLOTS = {
    'کلاس اول': {'start': '08:00', 'end': '10:00'},
    'کلاس دوم': {'start': '10:00', 'end': '12:00'},
    'کلاس سوم': {'start': '13:00', 'end': '15:00'},
    'کلاس چهارم': {'start': '15:00', 'end': '17:00'},
    'کلاس پنجم': {'start': '17:00', 'end': '19:00'}
}

class PDF(FPDF):
    def header(self, full_name, week_label, week_emoji):
        # Add Vazirmatn font (assuming it's in the same directory or accessible)
        # You might need to adjust the font path
        try:
            self.add_font('Vazir', '', 'Vazirmatn-Regular.ttf', uni=True)
            self.set_font('Vazir', '', 16)
        except Exception as e:
            print(f"Error loading font: {e}", file=sys.stderr)
            # Fallback to a standard font if Vazirmatn fails
            self.set_font('Arial', 'B', 16)

        self.set_y(10)
        self.cell(0, 10, 'برنامه هفتگی', 0, 1, 'C')
        self.set_font(self.font_family, '', 14)
        self.cell(0, 10, f'نام: {full_name}', 0, 1, 'C')
        self.cell(0, 10, f'هفته {week_label} {week_emoji}', 0, 1, 'C')
        self.ln(5) # Add some space after the header

    def footer(self):
        self.set_y(-15)
        # Add Vazirmatn font if not already added (should be in header)
        try:
             self.set_font('Vazir', '', 8)
        except:
             self.set_font('Arial', '', 8)
        self.cell(0, 10, '@WeekStatusBot', 0, 0, 'R') # Right align footer text
        self.cell(0, 10, f'صفحه {self.page_no()}/{{nb}}', 0, 0, 'L') # Left align page number

def generate_schedule_pdf(user_data):
    """
    Generates a PDF schedule based on user data.

    Args:
        user_data (dict): A dictionary containing 'fullName' and 'schedule'
                          where 'schedule' has 'odd_week_schedule' and
                          'even_week_schedule'.
    """
    full_name = user_data.get('fullName', 'کاربر')
    schedule = user_data.get('schedule', {})

    pdf = PDF(orientation='L', unit='mm', format='A4')
    pdf.alias_nb_pages()

    week_types = [
        {"type": "odd", "label": "فرد", "emoji": "🟣", "data": schedule.get('odd_week_schedule', {})},
        {"type": "even", "label": "زوج", "emoji": "🟢", "data": schedule.get('even_week_schedule', {})},
    ]

    for week_info in week_types:
        pdf.add_page()
        pdf.header(full_name, week_info['label'], week_info['emoji'])

        # Prepare table data
        table_headers = ['روز'] + [f'{slot_name}\n{slot_info["start"]} - {slot_info["end"]}' for slot_name, slot_info in TIME_SLOTS.items()]
        table_data = []

        for day_en, day_fa in zip(ENGLISH_WEEKDAYS, PERSIAN_WEEKDAYS):
            lessons = week_info['data'].get(day_en, [])
            row = [day_fa] + ['-'] * len(TIME_SLOTS) # Initialize row with '-'

            # Place lessons in correct time slots
            for lesson in lessons:
                start_time = lesson.get('start_time')
                lesson_text = f"{lesson.get('lesson', 'درس نامشخص')}\n{lesson.get('location', '-')}"

                slot_index = -1
                # Find the correct slot index based on start time
                for i, (slot_name, slot_info) in enumerate(TIME_SLOTS.items()):
                    if start_time and slot_info['start'] <= start_time < slot_info['end']:
                         slot_index = i + 1 # +1 because the first column is 'روز'
                         break

                if slot_index != -1:
                    # Append lesson text if slot is already occupied (handle multiple lessons in one slot)
                    if row[slot_index] == '-':
                        row[slot_index] = lesson_text
                    else:
                        row[slot_index] += f'\n---\n{lesson_text}' # Separate multiple lessons

            table_data.append(row)

        # Define column widths (adjust as needed for landscape A4)
        # Total width of A4 landscape is ~297mm. Margins are handled by auto_table.
        # Let's allocate widths: Day (25mm), 5 time slots (50mm each) = 25 + 5*50 = 275mm
        col_widths = [25] + [50] * len(TIME_SLOTS)

        # Add the table
        pdf.set_font(pdf.font_family, '', 10) # Set font for table content
        pdf.auto_table(
            table_data,
            headings=table_headers,
            cell_fill_color=(230, 230, 230), # Light grey header background
            cell_text_color=(0, 0, 0),
            cell_align='C', # Center align text in cells
            cell_valign='M', # Middle align text vertically
            cell_border='1',
            cell_padding=2,
            col_widths=col_widths,
            # Add styles for RTL and font
            styles={
                'font': 'Vazir', # Use the added font
                'align': 'R', # Right align text within cells (for RTL)
                'valign': 'M',
                'font_size': 10,
                'wrap_text': True, # Allow text wrapping
            },
            head_styles={
                 'font': 'Vazir',
                 'font_size': 11,
                 'font_style': 'B', # Bold header font
                 'fill_color': (200, 200, 200), # Darker grey header
                 'text_color': (0, 0, 0),
                 'align': 'C', # Center align header text
                 'valign': 'M',
                 'min_cell_height': 15, # Ensure header cells have minimum height
            },
            # Ensure RTL is applied to the table content
            # Note: fpdf2's auto_table handles RTL reasonably well with uni=True font
        )


    # Output the PDF to a byte stream
    pdf_output = io.BytesIO()
    pdf.output(dest='S').encode('latin-1') # Output as string, then encode
    # A better way to get bytes directly:
    pdf_bytes = pdf.output(dest='S').encode('utf-8') # Use utf-8 for bytes

    return pdf_bytes