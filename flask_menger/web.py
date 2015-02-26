from collections import defaultdict
from itertools import groupby, product, takewhile, dropwhile, cycle
from tempfile import mkdtemp
import logging
import os

from menger import Dimension, Measure, get_space

MAX_COMBINATION = 10**6
DEFAULT_LIMIT = 10**5

logger = logging.getLogger('menger.flask')
not_none = lambda x: x is not None
is_none = lambda x: x is None

class LimitException(Exception):
    pass

def nb_combination(lists):
    res = 1
    for l in lists:
        res = res * len(l)
    return res

def get_label(space, name, value):
    none_head = tuple(takewhile(is_none, value))
    none_tail = tuple(takewhile(is_none, reversed(value)))
    value = value[:-len(none_tail)]
    offset = len(none_head)
    dim = get_dimension(space, name)
    if not value:
        return dim.label
    return "%s: %s" % (
        dim.label,
        dim.format(value, offset=offset, fmt_type='txt')
    )


def get_dimension(space, name):
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space.name, name))
    dim = getattr(space, name)
    if not isinstance(dim, Dimension):
        raise Exception('%s is not a dimension on space  %s.' % (
            space.name, name))
    return dim


def get_head(values):
    """
    Return a tuple of the first non-None items in values list
    """
    return tuple(takewhile(not_none, values))

def get_tail(values):
    """
    Return a tuple of the first non-None items in values list
    """
    return tuple(dropwhile(is_none, values))

def mask(values, mask):
    '''
    Apply mask on each item:
    ex: [(2014, 1), (2014, 2)], (None,) -> [(None, 1), (None, 2)]
    '''
    cut = len(mask)
    for item in values:
        yield mask + item[cut:]

def patch(key, coordinates, to_patch):
    '''
    Fill missing slot on the key
    '''
    for pos, item in enumerate(key):
        if pos not in to_patch:
            yield item
            continue
        # Compute position of the mask
        i = to_patch[pos]
        mask = key[i]
        cut = len(mask)
        yield mask + item[cut:]

def get_measure(name):
    space_name, name = name.split('.')
    space = get_space(space_name)
    if not hasattr(space, name):
        raise Exception('Space %s has not attribute %s.' % (space._name, name))
    msr = getattr(space, name)
    if not isinstance(msr, Measure):
        raise Exception('%s is not a measure on space  %s.' % (
            space._name, name))

    return msr


def build_line(dimensions, key, coordinates, to_patch, all_coordinates,
               fmt_type=None):
    if fmt_type == 'json':
        line = []
        for dim, values, coord in zip(dimensions, key, coordinates):
            coord_name, coord_tuple = coord
            # Frozen dimension are ignored
            if None not in coord_tuple:
                continue
            offset = len(get_head(coord_tuple))
            offset += len(tuple(takewhile(is_none, values)))
            line.append(dim.format(values, offset=offset, fmt_type=fmt_type))
        return line

    line = []
    coord_pos = -1
    for dim, values, coord in zip(dimensions, key, coordinates):
        coord_pos += 1
        coord_name, coord_tuple = coord
        # Frozen dimension: we only show last value
        if None not in coord_tuple:
            offset = len(values) - 1
            val = [None] * offset + [values[-1]]
            line.append(dim.format(val, offset=offset, fmt_type=fmt_type))
            continue

        cut = None
        if coord_pos in to_patch:
            pdim, pvals = all_coordinates[to_patch[coord_pos]]
            tail = tuple(takewhile(not_none, reversed(pvals)))
            cut = len(pvals) - len(tail)

        for pos, coord in enumerate(coord_tuple):
            if coord is not None or (cut and pos < cut):
                continue
            value = [None] * pos + [values[pos]]
            line.append(dim.format(value, offset=pos, fmt_type=fmt_type))

    return line


def build_headers(spc, reg_coords, to_patch, all_coordinates):
    headers = []
    for coord_pos, (coord_name, coord_tuple) in enumerate(reg_coords):
        dim = get_dimension(spc, coord_name)
        # Frozen dimension: we only show one column
        if None not in coord_tuple:
            label = dim.levels[len(coord_tuple) - 1]
            parent = get_label(spc, coord_name, coord_tuple[:-1])

            headers.append({
                'label': label,
                'type': 'dimension',
                'parent': parent,
            })
            continue

        # If the current coordinate is patched, we hide corresponding
        # columns
        cut = None
        if coord_pos in to_patch:
            pdim, pvals = all_coordinates[to_patch[coord_pos]]
            tail = tuple(takewhile(not_none, reversed(pvals)))
            cut = len(pvals) - len(tail)

        for pos, coord in enumerate(coord_tuple):
            if coord is not None or (cut and pos < cut):
                continue

            label = dim.levels[pos]
            parent = get_label(spc, coord_name, coord_tuple)

            headers.append({
                'label': label,
                'type': 'dimension',
                'parent': parent,
            })

    return headers


def dice(coordinates, measures, **options):
    format_type = options.get('format_type')
    filters = options.get('filters')
    skip_zero = options.get('skip_zero')
    limit = options.get('limit') or DEFAULT_LIMIT

    if format_type == 'txt':
        pivot_on = options.get('pivot_on', [])
    else:
        pivot_on = []

    # Get space
    spc_name = measures[0].split('.')[0]
    spc = get_space(spc_name)
    if not spc:
        raise Exception('Space %s not found' % spc_name)

    # Split coordinates into regular and pivot coordinates
    reg_coords = [c for i, c in enumerate(coordinates) if i not in pivot_on]
    piv_coords = [coordinates[i] for i in pivot_on]

    # Recombine them
    coordinates = reg_coords + piv_coords
    dimensions = [get_dimension(spc, d) for d, v in coordinates]

    # Query DB
    drills = [list(get_dimension(spc, d).glob(v)) for d, v in coordinates]
    if nb_combination(drills) > MAX_COMBINATION:
        raise LimitException('Number of requested combination is too large')
    data_dict = dice_by_msr(coordinates, measures, filters=filters, limit=limit)

    # Collapsing phase, we remove some combinations that makes no
    # sense: Apply mask on drill values if the same dimension appear
    # several times
    to_patch = {}
    for i, (idim, ivals) in enumerate(coordinates):
        for j, (jdim, jvals) in enumerate(coordinates):
            if idim != jdim:
                continue
            if len(jvals) >= len(ivals):
                continue
            # Apply mask on drills and remove doubles
            drills[i] = sorted(set(mask(drills[i], jvals)))
            to_patch[i] = j

    # Split dimensions and drills in both groups
    reg_dims = dimensions[:len(reg_coords)]
    piv_dims = dimensions[len(reg_coords):]
    reg_drills = drills[:len(reg_coords)]
    piv_drills = drills[len(reg_coords):]

    # Create columns definition
    reg_cols = build_headers(spc, reg_coords, to_patch, coordinates)
    msr_cols = []

    for piv_key in product(*piv_drills):
        dim_names = []
        for d, v in zip(piv_dims, piv_key):
            tail = get_tail(v)
            offset = len(v) - len(tail)
            n = d.format(v, offset=offset, fmt_type=format_type)
            dim_names.append(n)

        for m in measures:
            space_name, name = m.split('.')
            msr = get_measure(m)
            space = get_space(space_name)

            msr_cols.append({
                'label': space._label + '/' + msr.label,
                'type': 'measure',
                'name': msr.name,
                'parent':  '|'.join(dim_names),
            })

    # Fill data
    data = []
    measures = [get_measure(m) for m in measures]
    totals = None

    for reg_key in product(*reg_drills):
        line = build_line(reg_dims, reg_key, reg_coords,
                          to_patch, coordinates,
                          fmt_type=format_type)
        values = []
        for piv_key in product(*piv_drills):
            key = reg_key + piv_key
            key = tuple(patch(key, coordinates, to_patch))
            values.extend(data_dict[key])

        # Skip zeros if asked
        if skip_zero and not any(values):
            continue

        line.extend(m.format(v, fmt_type=format_type) \
                    for m, v in zip(cycle(measures), values))
        data.append(line)

        # Aggregate totals
        if totals is None:
            totals = values
        else:
            for pos, v in enumerate(values):
                totals[pos] += v

    # Add total line
    if len(data) > 1:
        total_line = [''] * len(reg_cols)
        total_line.extend(m.format(v, fmt_type=format_type) \
                          for m, v in zip(cycle(measures), totals))
    else:
        total_line = None

    return {
        'data': data,
        'columns': reg_cols + msr_cols,
        'totals': total_line,
    }


def dice_by_msr(coordinates, measures, filters=None, limit=None):
    # Create one group of measures per space
    spc_msr = groupby((m.split('.') for m in measures),
                     lambda x: x[0])
    data = defaultdict(lambda: [0 for _ in measures])
    key_len = len(coordinates)
    for spc_pos, (spc_name, msrs) in enumerate(spc_msr):
        spc = get_space(spc_name)
        if not spc:
            raise Exception('space "%s" not found' % spc_name)

        filters = filters or {}
        results = spc.dice(coordinates, (m[1] for m in msrs), filters)
        for key, vals in results:
            if limit is not None and len(data) > limit:
                raise LimitException('Size limit reached')
            for pos, val in enumerate(vals):
                data[key][spc_pos + pos] = val
    return data


def build_xlsx(res):
    import openpyxl
    from openpyxl.cell import get_column_letter

    columns = res['columns']
    headers = []
    for col in columns:
        headers.append(col.get('parent'))

    wb = openpyxl.Workbook()
    sheet = wb.active
    sheet.title = 'Results'
    offset = 1

    if any(headers):
        offset += 1
        last_val = None
        merge_from = None
        for pos, val in enumerate(headers):
            if last_val is not None and val == last_val:
                if merge_from is None:
                    merge_from = pos
            else:
                if merge_from is not None:
                    sheet.merge_cells('%s1:%s1' % (
                        get_column_letter(merge_from),
                        get_column_letter(pos),
                    ))
                    merge_from = None

                last_val = val
                sheet.cell('%s1' % get_column_letter(pos+1)).value = val

    for pos, c in enumerate(columns):
        cell_id = '%s%s' % (get_column_letter(pos+1), offset)
        sheet.cell(cell_id).value = c['label']

    for line in res['data']:
        offset += 1
        for pos, value in enumerate(line):
            cell_id = '%s%s' % (get_column_letter(pos+1), offset)
            if isinstance(value, dict):
                sheet.cell(cell_id).style = value['style']
                value = value['value']
            sheet.cell(cell_id).value = value

    out = os.path.join(mkdtemp(), 'result.xlsx')
    wb.save(out)
    return out
